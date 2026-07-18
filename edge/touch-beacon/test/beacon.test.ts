import { describe, it, expect, vi, afterEach } from 'vitest';
import { sanitizeTouch } from '../src/validate.js';
import { handleRequest, type Env } from '../src/index.js';

const SID = '123e4567-e89b-42d3-a456-426614174000';

const makeEnv = (overrides: Partial<Env> = {}): Env => ({
  INGEST_TOKEN: 'test-ingest-token-0123456789',
  MIL_ORIGIN: 'https://mil-ingest.example.com',
  ALLOWED_ORIGINS: 'https://eassylife.in,https://www.eassylife.in',
  TOUCH_RATE: { limit: async () => ({ success: true }) },
  ...overrides,
});

const post = (body: unknown, origin: string | null = 'https://eassylife.in'): Request =>
  new Request('https://t.eassylife.in/t', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(origin ? { origin } : {}),
      'cf-connecting-ip': '203.0.113.9',
    },
    body: JSON.stringify(body),
  });

const ctx = () => {
  const waited: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => void waited.push(p),
    flush: () => Promise.all(waited),
    waited,
  };
};

afterEach(() => vi.unstubAllGlobals());

describe('sanitizeTouch', () => {
  it('accepts a consented web landing and keeps utm + click ids', () => {
    const out = sanitizeTouch({
      session_id: SID,
      touch_type: 'first_party_click',
      utm_campaign: 'monsoon_sale',
      gclid: 'g-123',
      consent: true,
      landing_url: 'https://eassylife.in/?utm_campaign=monsoon_sale',
    });
    expect(out).toMatchObject({
      app: 'services',
      session_id: SID,
      touch_type: 'first_party_click',
      utm_campaign: 'monsoon_sale',
      gclid: 'g-123',
      consent: true,
    });
  });

  it('strips click ids without consent but keeps the utm touch', () => {
    const out = sanitizeTouch({
      session_id: SID,
      utm_campaign: 'monsoon_sale',
      gclid: 'g-123',
      consent: false,
    });
    expect(out).toMatchObject({ utm_campaign: 'monsoon_sale', consent: false });
    expect(out).not.toHaveProperty('gclid');
  });

  it('never forwards identity/server-only fields, forces app', () => {
    const out = sanitizeTouch({
      session_id: SID,
      utm_campaign: 'x',
      user_id: 42,
      wa_phone_hash: 'a'.repeat(64),
      ctwa_clid: 'abc',
      channel: 'ctwa',
      app: 'society',
      raw: { evil: true },
      consent: true,
    });
    expect(out!.app).toBe('services');
    for (const k of ['user_id', 'wa_phone_hash', 'ctwa_clid', 'channel', 'raw']) {
      expect(out).not.toHaveProperty(k);
    }
  });

  it('rejects missing/malformed session_id, bad touch_type, and signal-less bodies', () => {
    expect(sanitizeTouch({ utm_campaign: 'x' })).toBeNull();
    expect(sanitizeTouch({ session_id: 'not-a-uuid', utm_campaign: 'x' })).toBeNull();
    expect(sanitizeTouch({ session_id: SID, touch_type: 'lead', utm_campaign: 'x' })).toBeNull();
    expect(sanitizeTouch({ session_id: SID })).toBeNull(); // no campaign signal
    expect(sanitizeTouch(null)).toBeNull();
  });

  it('drops stale/future occurred_at but keeps a recent one', () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    const stale = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
    expect(
      sanitizeTouch({ session_id: SID, utm_campaign: 'x', occurred_at: recent })!.occurred_at,
    ).toBe(recent);
    expect(
      sanitizeTouch({ session_id: SID, utm_campaign: 'x', occurred_at: stale })!.occurred_at,
    ).toBeUndefined();
  });
});

describe('handleRequest', () => {
  it('204 + CORS echo for an allowed origin, forwards with bearer token', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const env = makeEnv();
    const c = ctx();
    const res = await handleRequest(
      post({ session_id: SID, utm_campaign: 'x', touch_type: 'first_party_click' }),
      env,
      c,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://eassylife.in');
    await c.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://mil-ingest.example.com/ingest/touch');
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer test-ingest-token-0123456789',
    );
  });

  it('allows native (no-Origin) requests, rejects unknown browser origins', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const env = makeEnv();
    const ok = await handleRequest(post({ session_id: SID, utm_campaign: 'x' }, null), env, ctx());
    expect(ok.status).toBe(204);
    const bad = await handleRequest(
      post({ session_id: SID, utm_campaign: 'x' }, 'https://evil.example'),
      env,
      ctx(),
    );
    expect(bad.status).toBe(403);
  });

  it('429 when the rate limiter trips; 400 on garbage; 404 off-path', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const limited = makeEnv({ TOUCH_RATE: { limit: async () => ({ success: false }) } });
    expect((await handleRequest(post({ session_id: SID, utm_campaign: 'x' }), limited, ctx())).status).toBe(429);
    expect((await handleRequest(post({ nope: 1 }), makeEnv(), ctx())).status).toBe(400);
    const off = new Request('https://t.eassylife.in/other', { method: 'POST' });
    expect((await handleRequest(off, makeEnv(), ctx())).status).toBe(404);
  });

  it('fail-open: still 204 when MIL forward hard-fails', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('tunnel down');
    });
    vi.stubGlobal('fetch', fetchMock);
    const c = ctx();
    const res = await handleRequest(post({ session_id: SID, utm_campaign: 'x' }), makeEnv(), c);
    expect(res.status).toBe(204);
    await c.flush(); // must not throw
    expect(fetchMock).toHaveBeenCalledTimes(2); // one retry
  });
});
