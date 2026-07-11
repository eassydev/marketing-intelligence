import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { buildReviewSources } from '../src/marketing/reviews/factory.js';
import { AppStoreSource } from '../src/marketing/reviews/app-store.js';
import { PlayStoreSource } from '../src/marketing/reviews/play-store.js';
import { GoogleBusinessSource } from '../src/marketing/reviews/google-business.js';
import {
  parseServiceAccountKey,
  buildJwtAssertion,
} from '../src/marketing/reviews/google-auth.js';
import { runReviewsIngest } from '../src/marketing/reviews/run.js';

afterEach(() => vi.unstubAllGlobals());

// A real (throwaway) RSA key so RS256 signing paths run end to end.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA_KEY_JSON = JSON.stringify({
  client_email: 'mil-reviews@test-project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
});

const EMPTY_ENV = { APP_STORE_COUNTRY: 'in' };

describe('buildReviewSources', () => {
  it('returns no sources when no creds are configured (each skipped, none throw)', () => {
    expect(buildReviewSources(EMPTY_ENV)).toEqual([]);
  });

  it('builds exactly the sources whose creds are present', () => {
    const sources = buildReviewSources({
      ...EMPTY_ENV,
      APP_STORE_APP_ID: '123456789',
      GOOGLE_PLAY_PACKAGE_NAME: 'com.eassylife.customer',
      GOOGLE_PLAY_SA_KEY_JSON: SA_KEY_JSON,
    });
    expect(sources.map((s) => s.source).sort()).toEqual(['app_store', 'play_store']);
  });

  it('skips a source with PARTIAL creds (GBP needs account + location + key)', () => {
    const sources = buildReviewSources({ ...EMPTY_ENV, GBP_ACCOUNT_ID: 'acc-1' });
    expect(sources).toEqual([]);
  });
});

describe('runReviewsIngest gating', () => {
  it('skips cleanly (no fetch, no DB) when no source creds are set', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await runReviewsIngest();
    expect(result).toEqual({ sources: 0, written: 0, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('google-auth', () => {
  it('rejects malformed / incomplete service-account key JSON', () => {
    expect(() => parseServiceAccountKey('not-json')).toThrow('not valid JSON');
    expect(() => parseServiceAccountKey('{"client_email":"a@b.c"}')).toThrow(
      'client_email and private_key',
    );
  });

  it('builds a verifiable RS256 JWT with the expected claims', () => {
    const key = parseServiceAccountKey(SA_KEY_JSON);
    const scope = 'https://www.googleapis.com/auth/androidpublisher';
    const jwt = buildJwtAssertion(key, scope, 1_760_000_000);
    const [header, claims, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toMatchObject({
      iss: key.client_email,
      scope,
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_760_000_000,
      exp: 1_760_003_600,
    });
    const verified = crypto
      .createVerify('RSA-SHA256')
      .update(`${header}.${claims}`)
      .verify(publicKey, Buffer.from(signature!, 'base64url'));
    expect(verified).toBe(true);
  });
});

describe('AppStoreSource', () => {
  it('snapshots aggregate rating from the iTunes lookup (no auth needed)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          results: [{ averageUserRating: 4.5766, userRatingCount: 12345 }],
        }),
      })),
    );
    const snap = await new AppStoreSource({ appId: '123', country: 'in' }).fetchSnapshot();
    expect(snap.ratingAvg).toBe(4.58);
    expect(snap.ratingCount).toBe(12345);
    expect(snap.newReviewsCount).toBeNull(); // lookup exposes aggregates only
  });

  it('throws when the lookup returns no app (run.ts logs + continues)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) })),
    );
    await expect(
      new AppStoreSource({ appId: '999', country: 'in' }).fetchSnapshot(),
    ).rejects.toThrow('no app');
  });
});

describe('PlayStoreSource', () => {
  it('averages recent commented reviews; lifetime aggregate stays null', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'tok-1' }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          reviews: [
            { comments: [{ userComment: { starRating: 5 } }] },
            { comments: [{ userComment: { starRating: 4 } }] },
            { comments: [] }, // review without a parseable rating — ignored
          ],
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const snap = await new PlayStoreSource({
      packageName: 'com.eassylife.customer',
      saKeyJson: SA_KEY_JSON,
    }).fetchSnapshot();

    expect(snap.ratingAvg).toBe(4.5);
    expect(snap.ratingCount).toBeNull(); // API exposes no lifetime aggregate
    expect(snap.newReviewsCount).toBe(3);
    const reviewsCall = fetchMock.mock.calls.find(([u]) =>
      (u as string).includes('androidpublisher'),
    )!;
    expect(reviewsCall[0]).toContain('/applications/com.eassylife.customer/reviews');
    expect(reviewsCall[1]?.headers).toMatchObject({ authorization: 'Bearer tok-1' });
  });
});

describe('GoogleBusinessSource', () => {
  it('snapshots the location aggregate rating + total review count', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'tok-2' }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ averageRating: 4.312, totalReviewCount: 890, reviews: [{}] }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const snap = await new GoogleBusinessSource({
      accountId: 'acc-1',
      locationId: 'loc-1',
      saKeyJson: SA_KEY_JSON,
    }).fetchSnapshot();

    expect(snap.ratingAvg).toBe(4.31);
    expect(snap.ratingCount).toBe(890);
    expect(snap.newReviewsCount).toBeNull();
    const gbpCall = fetchMock.mock.calls.find(([u]) => (u as string).includes('mybusiness'))!;
    expect(gbpCall[0]).toContain('/accounts/acc-1/locations/loc-1/reviews');
  });
});
