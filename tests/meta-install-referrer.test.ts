import { describe, it, expect } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';
import {
  applyMetaInstallReferrer,
  decryptMetaEnvelope,
  decryptMetaInstallReferrer,
  extractMetaEnvelope,
  metaIdsFromDecoded,
  quoteLongIntegers,
} from '../src/marketing/attribution/meta-install-referrer.js';
import type { TouchIngest } from '../src/marketing/ingest/validators.js';

const KEY = randomBytes(32).toString('hex');
const APP_ID = 1717873222070120;

const DECODED = {
  ad_id: '120248379262110475',
  adgroup_id: '120248379262110475',
  adgroup_name: 'Home Deep cleaning',
  campaign_id: '120248378036420475',
  campaign_name: 'Mumbai adset',
  campaign_group_id: '120248378036410475',
  campaign_group_name: 'el_June26_Mumbai_Campaign',
  account_id: '1590266817975480',
  ad_objective_name: 'OUTCOME_SALES',
  is_instagram: true,
  publisher_platform: 'instagram',
  platform_position: 'instagram_reels',
};

/** Build Meta's envelope exactly as it appears in the Play referrer. */
function encryptEnvelope(plaintext: object | string, keyHex = KEY): { data: string; nonce: string } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), nonce);
  const text = typeof plaintext === 'string' ? plaintext : JSON.stringify(plaintext);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return {
    data: Buffer.concat([body, cipher.getAuthTag()]).toString('hex'),
    nonce: nonce.toString('hex'),
  };
}

function playReferrer(label: 'fb4a' | 'ig4a', source: { data: string; nonce: string }): string {
  const utmContent = JSON.stringify({ app: APP_ID, t: 1788258089, source });
  const host = label === 'fb4a' ? 'apps.facebook.com' : 'apps.instagram.com';
  return `utm_source=${host}&utm_campaign=${label}&utm_content=${encodeURIComponent(utmContent)}`;
}

const baseTouch = (overrides: Partial<TouchIngest> = {}): TouchIngest => ({
  app: 'services',
  session_id: '123e4567-e89b-42d3-a456-426614174000',
  touch_type: 'touch',
  consent: true,
  utm_source: 'apps.instagram.com',
  utm_campaign: 'ig4a',
  ...overrides,
});

describe('extractMetaEnvelope', () => {
  it('finds the envelope inside a URL-encoded Play referrer', () => {
    const env = extractMetaEnvelope({ referrer: playReferrer('ig4a', encryptEnvelope(DECODED)) });
    expect(env).not.toBeNull();
    expect(env!.app).toBe(String(APP_ID));
    expect(env!.clickTs).toBe(1788258089);
    expect(env!.nonce).toHaveLength(12);
  });

  it('accepts the envelope passed directly as utm_content', () => {
    const source = encryptEnvelope(DECODED);
    const env = extractMetaEnvelope({ utm_content: JSON.stringify({ app: APP_ID, source }) });
    expect(env).not.toBeNull();
  });

  it.each([
    ['organic install', 'utm_source=google-play&utm_medium=organic'],
    ['truncated JSON', 'utm_source=apps.facebook.com&utm_campaign=fb4a&utm_content=%7B%22source%22%3A%7B%22da'],
    ['non-hex data', `utm_content=${encodeURIComponent('{"source":{"data":"' + 'zz'.repeat(40) + '","nonce":"00112233445566778899aabb"}}')}`],
    ['odd-length data', `utm_content=${encodeURIComponent('{"source":{"data":"' + 'a'.repeat(81) + '","nonce":"00112233445566778899aabb"}}')}`],
    ['source not an object', `utm_content=${encodeURIComponent('{"source":"x"}')}`],
    ['short nonce', `utm_content=${encodeURIComponent('{"source":{"data":"' + 'ab'.repeat(40) + '","nonce":"0011"}}')}`],
  ])('returns null for %s', (_label, referrer) => {
    expect(extractMetaEnvelope({ referrer })).toBeNull();
  });

  it('returns null when nothing is supplied', () => {
    expect(extractMetaEnvelope({})).toBeNull();
  });
});

describe('decryptMetaEnvelope', () => {
  it('round-trips with the right key', () => {
    const env = extractMetaEnvelope({ referrer: playReferrer('fb4a', encryptEnvelope(DECODED)) })!;
    expect(decryptMetaEnvelope(env, KEY)).toEqual(DECODED);
  });

  it('returns null with the wrong key (GCM auth fails)', () => {
    const env = extractMetaEnvelope({ referrer: playReferrer('fb4a', encryptEnvelope(DECODED)) })!;
    expect(decryptMetaEnvelope(env, randomBytes(32).toString('hex'))).toBeNull();
  });

  it('returns null for a malformed key', () => {
    const env = extractMetaEnvelope({ referrer: playReferrer('fb4a', encryptEnvelope(DECODED)) })!;
    expect(decryptMetaEnvelope(env, 'not-a-key')).toBeNull();
  });

  it('returns null when the tag is tampered', () => {
    const source = encryptEnvelope(DECODED);
    const flipped = (source.data.slice(-1) === '0' ? '1' : '0');
    const tampered = { ...source, data: source.data.slice(0, -1) + flipped };
    const env = extractMetaEnvelope({ referrer: playReferrer('fb4a', tampered) })!;
    expect(decryptMetaEnvelope(env, KEY)).toBeNull();
  });

  it('keeps 18-digit ids exact when Meta sends them as bare JSON numbers', () => {
    const plaintext =
      '{"campaign_group_id":120248378036410475,"campaign_id":120248378036420475,"adgroup_id":120248379262110475,"campaign_group_name":"x:1234567890123456789"}';
    const env = extractMetaEnvelope({ referrer: playReferrer('ig4a', encryptEnvelope(plaintext)) })!;
    const decoded = decryptMetaEnvelope(env, KEY)!;
    expect(decoded.campaign_group_id).toBe('120248378036410475');
    expect(decoded.campaign_group_name).toBe('x:1234567890123456789');
    expect(metaIdsFromDecoded(decoded)!.adId).toBe('120248379262110475');
  });

  it('returns null when the plaintext is not a JSON object', () => {
    const env = extractMetaEnvelope({ referrer: playReferrer('fb4a', encryptEnvelope(['x'])) })!;
    expect(decryptMetaEnvelope(env, KEY)).toBeNull();
  });
});

describe('quoteLongIntegers', () => {
  it('quotes only bare 16+ digit integers outside strings', () => {
    expect(quoteLongIntegers('{"a":120248378036410475,"b":12,"c":"99999999999999999"}')).toBe(
      '{"a":"120248378036410475","b":12,"c":"99999999999999999"}',
    );
  });

  it('leaves decimals, exponents, negatives and escaped quotes alone', () => {
    const json = '{"d":1234567890123456.5,"e":1234567890123456e2,"n":-1234567890123456789,"s":"a\\"1234567890123456789"}';
    expect(quoteLongIntegers(json)).toBe(json);
  });
});

describe('metaIdsFromDecoded', () => {
  it('maps Meta legacy names: campaign_group=campaign, campaign=ad set, adgroup=ad', () => {
    const ids = metaIdsFromDecoded(DECODED)!;
    expect(ids.campaignKey).toBe('120248378036410475');
    expect(ids.adsetId).toBe('120248378036420475');
    expect(ids.adId).toBe('120248379262110475');
  });

  it('accepts numeric ids and falls back to the most campaign-level id present', () => {
    const ids = metaIdsFromDecoded({ campaign_id: 120248378036420, adgroup_id: 99 })!;
    expect(ids.campaignKey).toBe('120248378036420');
    expect(ids.adId).toBe('99');
  });

  it('keeps only whitelisted fields', () => {
    const ids = metaIdsFromDecoded({ ...DECODED, unexpected: 'x' })!;
    expect(ids.decoded).not.toHaveProperty('unexpected');
    expect(ids.decoded.campaign_group_name).toBe('el_June26_Mumbai_Campaign');
  });

  it('returns null when no usable id exists', () => {
    expect(metaIdsFromDecoded({ campaign_group_id: 'abc' })).toBeNull();
  });
});

describe('decryptMetaInstallReferrer + applyMetaInstallReferrer', () => {
  it('reports absent / malformed / no_key / decrypt_failed / no_ids / ok', () => {
    const referrer = playReferrer('ig4a', encryptEnvelope(DECODED));
    const status = (input: { referrer?: string }, key: string | undefined) =>
      decryptMetaInstallReferrer(input, key).status;
    expect(status({ referrer: 'utm_source=google-play' }, KEY)).toBe('absent');
    expect(status({ referrer: referrer.slice(0, 200) }, KEY)).toBe('malformed');
    expect(status({ referrer }, undefined)).toBe('no_key');
    expect(status({ referrer }, randomBytes(32).toString('hex'))).toBe('decrypt_failed');
    expect(status({ referrer: playReferrer('ig4a', encryptEnvelope({ campaign_group_name: 'x' })) }, KEY)).toBe('no_ids');
    expect(status({ referrer }, KEY)).toBe('ok');
  });

  it('rewrites the touch to Meta ids without mutating the input', () => {
    const referrer = playReferrer('ig4a', encryptEnvelope(DECODED));
    const touch = baseTouch({ referrer });
    const snapshot = JSON.parse(JSON.stringify(touch));
    const result = decryptMetaInstallReferrer(touch, KEY);
    if (result.status !== 'ok') throw new Error('expected ok');

    const fixed = applyMetaInstallReferrer(touch, result);
    expect(fixed.utm_campaign).toBe('120248378036410475');
    expect(fixed.utm_term).toBe('120248378036420475');
    expect(fixed.utm_content).toBe('120248379262110475');
    expect(fixed.channel).toBe('meta');
    expect(fixed.referrer).toBe(referrer);
    const meta = (fixed.raw as Record<string, any>).meta_install_referrer;
    expect(meta.original).toEqual({
      utm_source: 'apps.instagram.com',
      utm_campaign: 'ig4a',
      utm_term: null,
      utm_content: null,
    });
    expect(meta.app).toBe(String(APP_ID));
    expect(meta.nonce).toMatch(/^[0-9a-f]{24}$/);
    expect(meta.click_ts).toBe(1788258089);
    expect(meta.decoded.campaign_group_name).toBe('el_June26_Mumbai_Campaign');
    expect(touch).toEqual(snapshot);
  });

  it('keeps an explicit channel and merges existing raw', () => {
    const touch = baseTouch({
      referrer: playReferrer('fb4a', encryptEnvelope(DECODED)),
      channel: 'ctwa',
      raw: { kind: 'app_install' },
    });
    const result = decryptMetaInstallReferrer(touch, KEY);
    if (result.status !== 'ok') throw new Error('expected ok');
    const fixed = applyMetaInstallReferrer(touch, result);
    expect(fixed.channel).toBe('ctwa');
    expect((fixed.raw as Record<string, unknown>).kind).toBe('app_install');
  });
});
