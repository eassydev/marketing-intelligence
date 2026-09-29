import { createDecipheriv } from 'node:crypto';
import type { TouchIngest } from '../ingest/validators.js';

/**
 * Meta app-ad install referrer decryption.
 *
 * For installs from Facebook/Instagram app ads, Meta writes the Google Play
 * install referrer as
 *   utm_source=apps.facebook.com&utm_campaign=fb4a&utm_content={"app":<app id>,
 *     "t":<click ts>,"source":{"data":"<hex>","nonce":"<hex>"}}
 * The generic fb4a/ig4a label joins no ad entity; the real ids exist only inside
 * `data`, AES-256-GCM encrypted with the app's Install Referrer Decryption Key
 * (16-byte auth tag appended to the ciphertext). GCM authentication also means a
 * decrypted envelope cannot be forged without the key. Pure module — no DB, no env.
 */

const NONCE_HEX_LEN = 24; // 12-byte GCM nonce
const TAG_BYTES = 16;
const HEX_RE = /^[0-9a-f]+$/i;
const KEY_RE = /^[0-9a-f]{64}$/i;
const NUMERIC_ID_RE = /^\d{1,32}$/;
/** Meta ids are 17-18 digits — beyond Number.MAX_SAFE_INTEGER as bare JSON numbers. */
const LONG_INTEGER_DIGITS = 16;
/** `t` sits OUTSIDE the GCM-authenticated data, so it is only trusted as a
 * plausible whole-second click time: after 2017, not after now (+10 min skew). */
const MIN_CLICK_TS = 1_500_000_000;
const MAX_CLICK_SKEW_S = 600;

/** Decoded fields worth keeping. All are ad-structure metadata — no user data. */
const KEPT_FIELDS = [
  'account_id',
  'ad_id',
  'adgroup_id',
  'adgroup_name',
  'campaign_id',
  'campaign_name',
  'campaign_group_id',
  'campaign_group_name',
  'ad_objective_name',
  'is_instagram',
  'publisher_platform',
  'platform_position',
] as const;

export interface MetaReferrerEnvelope {
  app: string | null;
  /** Ad-click time (unix seconds) from the envelope. */
  clickTs: number | null;
  data: Buffer;
  nonce: Buffer;
}

export interface MetaReferrerIds {
  /** Most campaign-level id present; the funnel's alias CTE resolves any level. */
  campaignKey: string;
  adsetId: string | null;
  adId: string | null;
  decoded: Record<string, unknown>;
}

export type MetaReferrerResult =
  | { status: 'absent' }
  | { status: 'malformed' } // mentions Meta's envelope but does not parse
  | { status: 'no_key' }
  | { status: 'decrypt_failed' } // wrong key or tampered data
  | { status: 'no_ids' } // decrypted, but no usable campaign/adset/ad id
  | { status: 'ok'; envelope: MetaReferrerEnvelope; ids: MetaReferrerIds };

function utmContentFromReferrer(referrer: string): string | null {
  try {
    const query = referrer.startsWith('?') ? referrer.slice(1) : referrer;
    return new URLSearchParams(query).get('utm_content');
  } catch {
    return null;
  }
}

const NUMBER_TOKEN_RE = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/**
 * Wrap bare non-negative integer tokens of 16+ digits in quotes so JSON.parse
 * keeps them exact. Whole number tokens are matched, so decimals and exponents
 * pass through untouched, and nothing inside string literals is changed.
 */
export function quoteLongIntegers(json: string): string {
  let out = '';
  let inString = false;
  let i = 0;
  while (i < json.length) {
    const ch = json[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < json.length) {
        out += json[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      NUMBER_TOKEN_RE.lastIndex = i;
      const token = NUMBER_TOKEN_RE.exec(json)?.[0];
      if (token) {
        const pureInteger = /^\d+$/.test(token);
        out += pureInteger && token.length >= LONG_INTEGER_DIGITS ? `"${token}"` : token;
        i += token.length;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

function asId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && NUMERIC_ID_RE.test(value)) return value;
  return null;
}

function plausibleClickTs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  const maxTs = Math.floor(Date.now() / 1000) + MAX_CLICK_SKEW_S;
  return value >= MIN_CLICK_TS && value <= maxTs ? value : null;
}

function mentionsEnvelope(value: string | null | undefined): boolean {
  return !!value && (value.includes('"source"') || value.toLowerCase().includes('%22source%22'));
}

/**
 * Find Meta's encrypted envelope in an explicit utm_content or inside a raw
 * Play referrer query string.
 */
export function extractMetaEnvelope(input: {
  referrer?: string | null;
  utm_content?: string | null;
}): MetaReferrerEnvelope | null {
  const candidates = [
    input.utm_content,
    input.referrer ? utmContentFromReferrer(input.referrer) : null,
  ];
  for (const candidate of candidates) {
    if (!candidate || !candidate.includes('"source"')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(quoteLongIntegers(candidate));
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const obj = parsed as Record<string, unknown>;
    const source = obj.source;
    if (typeof source !== 'object' || source === null) continue;
    const { data, nonce } = source as Record<string, unknown>;
    if (typeof data !== 'string' || typeof nonce !== 'string') continue;
    if (nonce.length !== NONCE_HEX_LEN || !HEX_RE.test(nonce)) continue;
    if (data.length % 2 !== 0 || data.length <= TAG_BYTES * 2 || !HEX_RE.test(data)) continue;
    const clickTs = plausibleClickTs(obj.t);
    return {
      app: asId(obj.app),
      clickTs,
      data: Buffer.from(data, 'hex'),
      nonce: Buffer.from(nonce, 'hex'),
    };
  }
  return null;
}

/** AES-256-GCM decrypt; null on a wrong key, tampered data or non-JSON plaintext. */
export function decryptMetaEnvelope(
  envelope: MetaReferrerEnvelope,
  keyHex: string,
): Record<string, unknown> | null {
  if (!KEY_RE.test(keyHex)) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), envelope.nonce);
    decipher.setAuthTag(envelope.data.subarray(envelope.data.length - TAG_BYTES));
    const plaintext = Buffer.concat([
      decipher.update(envelope.data.subarray(0, envelope.data.length - TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
    const decoded: unknown = JSON.parse(quoteLongIntegers(plaintext));
    return typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded)
      ? (decoded as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Map Meta's legacy field names to ids. Meta's API naming is historical:
 * campaign_group = campaign, campaign = ad set, adgroup = ad. The funnel's
 * campaign_alias resolves ad/adset/campaign ids alike, so a mislabelled field
 * still lands on the right campaign — ids, not names, are what we trust.
 */
export function metaIdsFromDecoded(decoded: Record<string, unknown>): MetaReferrerIds | null {
  const campaignId = asId(decoded.campaign_group_id);
  const adsetId = asId(decoded.campaign_id);
  const adId = asId(decoded.ad_id) ?? asId(decoded.adgroup_id);
  const campaignKey = campaignId ?? adsetId ?? adId;
  if (!campaignKey) return null;
  const kept: Record<string, unknown> = {};
  for (const field of KEPT_FIELDS) {
    if (decoded[field] !== undefined) kept[field] = decoded[field];
  }
  return { campaignKey, adsetId, adId, decoded: kept };
}

export function decryptMetaInstallReferrer(
  input: { referrer?: string | null; utm_content?: string | null },
  keyHex: string | undefined,
): MetaReferrerResult {
  const envelope = extractMetaEnvelope(input);
  if (!envelope) {
    return mentionsEnvelope(input.utm_content) || mentionsEnvelope(input.referrer)
      ? { status: 'malformed' }
      : { status: 'absent' };
  }
  if (!keyHex) return { status: 'no_key' };
  const decoded = decryptMetaEnvelope(envelope, keyHex);
  if (!decoded) return { status: 'decrypt_failed' };
  const ids = metaIdsFromDecoded(decoded);
  return ids ? { status: 'ok', envelope, ids } : { status: 'no_ids' };
}

/**
 * Return a copy of the touch with Meta's real ids in place of fb4a/ig4a, using
 * the same utm convention as Meta's own URL parameters
 * (utm_campaign={campaign.id}, utm_term={adset.id}, utm_content={ad.id}).
 * The original labels, the envelope nonce (one per install — the funnel's
 * install dedup key) and the decoded fields are preserved in raw.
 */
export function applyMetaInstallReferrer(
  touch: TouchIngest,
  result: Extract<MetaReferrerResult, { status: 'ok' }>,
): TouchIngest {
  const { envelope, ids } = result;
  return {
    ...touch,
    utm_campaign: ids.campaignKey,
    utm_term: ids.adsetId ?? touch.utm_term ?? null,
    utm_content: ids.adId ?? touch.utm_content ?? null,
    channel: touch.channel ?? 'meta',
    raw: {
      ...(touch.raw ?? {}),
      meta_install_referrer: {
        app: envelope.app,
        click_ts: envelope.clickTs,
        nonce: envelope.nonce.toString('hex'),
        original: {
          utm_source: touch.utm_source ?? null,
          utm_campaign: touch.utm_campaign ?? null,
          utm_term: touch.utm_term ?? null,
          utm_content: touch.utm_content ?? null,
        },
        decoded: ids.decoded,
      },
    },
  };
}
