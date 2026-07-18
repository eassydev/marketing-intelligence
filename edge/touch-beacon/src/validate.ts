/**
 * Beacon payload sanitizer — the edge mirror of MIL's touchIngestSchema, kept
 * dependency-free (no zod at the edge). Whitelist-only: anything not listed is
 * dropped, `app` is forced server-side, and identity-bearing fields the public
 * MUST NOT set (user_id, wa_phone_hash, ctwa_clid, channel, raw) are never
 * forwarded. Click-ids are stripped unless consent === true (DPDP).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TOUCH_TYPES = new Set(['touch', 'first_party_click']);

/** utm_* — never identifiers, always forwarded when present. */
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;

/** Click/cookie identifiers — forwarded ONLY with consent. */
const CLICK_ID_KEYS = ['gclid', 'fbclid', 'gbraid', 'wbraid', 'fbc', 'fbp'] as const;

const MAX_ID_LEN = 512; // click ids / urls
const MAX_UTM_LEN = 256;
const OCCURRED_AT_MAX_AGE_MS = 30 * 24 * 3600 * 1000; // 30d back
const OCCURRED_AT_MAX_SKEW_MS = 10 * 60 * 1000; // 10min forward

export interface SanitizedTouch {
  app: 'services';
  session_id: string;
  touch_type: 'touch' | 'first_party_click';
  consent: boolean;
  occurred_at?: string;
  landing_url?: string;
  referrer?: string;
  [key: string]: unknown; // utm_* / click ids added dynamically
}

function cleanString(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLen) return null;
  return trimmed;
}

/**
 * Validate + sanitize a raw beacon body. Returns the payload to forward to MIL,
 * or null when the request is not a plausible touch (missing/malformed
 * session_id, bad touch_type, or no campaign signal at all).
 */
export function sanitizeTouch(input: unknown): SanitizedTouch | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const body = input as Record<string, unknown>;

  const sessionId = cleanString(body.session_id, 64);
  if (!sessionId || !UUID_RE.test(sessionId)) return null;

  const touchType = body.touch_type === undefined ? 'touch' : body.touch_type;
  if (typeof touchType !== 'string' || !TOUCH_TYPES.has(touchType)) return null;

  const consent = body.consent === true;

  const out: SanitizedTouch = {
    app: 'services',
    session_id: sessionId,
    touch_type: touchType as SanitizedTouch['touch_type'],
    consent,
  };

  let hasSignal = false;
  for (const key of UTM_KEYS) {
    const value = cleanString(body[key], MAX_UTM_LEN);
    if (value) {
      out[key] = value;
      hasSignal = true;
    }
  }
  if (consent) {
    for (const key of CLICK_ID_KEYS) {
      const value = cleanString(body[key], MAX_ID_LEN);
      if (value) {
        out[key] = value;
        hasSignal = true;
      }
    }
  } else if (CLICK_ID_KEYS.some((k) => typeof body[k] === 'string' && body[k])) {
    // Click-ids arrived without consent: dropped, but they still prove this was
    // a campaign landing — keep the touch (utm-only) rather than rejecting it.
    hasSignal = true;
  }

  // A touch with no campaign signal whatsoever is noise — reject.
  if (!hasSignal) return null;

  const landingUrl = cleanString(body.landing_url, MAX_ID_LEN);
  if (landingUrl) out.landing_url = landingUrl;
  const referrer = cleanString(body.referrer, MAX_ID_LEN);
  if (referrer) out.referrer = referrer;

  // Client clocks lie: accept occurred_at only within [now-30d, now+10min],
  // else omit and let MIL default to receive time.
  const occurredAt = cleanString(body.occurred_at, 64);
  if (occurredAt) {
    const ts = Date.parse(occurredAt);
    const now = Date.now();
    if (
      !Number.isNaN(ts) &&
      ts >= now - OCCURRED_AT_MAX_AGE_MS &&
      ts <= now + OCCURRED_AT_MAX_SKEW_MS
    ) {
      out.occurred_at = new Date(ts).toISOString();
    }
  }

  return out;
}
