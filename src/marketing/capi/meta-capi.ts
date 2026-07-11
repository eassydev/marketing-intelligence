/**
 * Meta Conversions API (CAPI) client — server-side Purchase upload.
 *
 * Ports the working pattern from WACRM (src/lib/capi.ts) and the Swarg
 * meta-conversion route: SHA-256 hashing of PII identifiers, native fetch,
 * events_received/error parsing. Pure and unit-testable — no DB or env here.
 *
 * MIL holds no email/phone, so user_data carries hashed external_id (userId)
 * + hashed city (ct), plus RAW fbc/fbp (cookie IDs, not hashed per Meta spec).
 * event_id = order_id dedups the server event against the browser pixel.
 */
import crypto from 'node:crypto';
import { createChildLogger } from '../../shared/logger/index.js';

const log = createChildLogger({ module: 'meta-capi' });

const TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 1_000;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** SHA-256 of a normalized (trimmed, lowercased) value — Meta's PII hashing rule. */
export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

export interface ConversionRow {
  orderId: string;
  userId: number | string | null;
  valueInr: number | string;
  occurredAt: Date | string;
  actionSource: string | null;
  city: string | null;
  fbc: string | null;
  fbp: string | null;
  ctwaClid?: string | null; // CTWA click id → business_messaging envelope
}

export interface MetaEvent {
  event_name: 'Purchase' | 'Lead';
  event_time: number;
  event_id: string;
  action_source: 'website' | 'app' | 'business_messaging';
  messaging_channel?: 'whatsapp'; // required alongside business_messaging
  user_data: Record<string, unknown>;
  custom_data?: { value: number; currency: 'INR' }; // Purchase only
}

/** Only website|app are valid action_sources for these first-party purchases. */
function toActionSource(src: string | null): 'website' | 'app' {
  return src === 'app' ? 'app' : 'website';
}

const toUnixSeconds = (occurredAt: Date | string): number => {
  const occurred = occurredAt instanceof Date ? occurredAt : new Date(occurredAt);
  return Math.floor(occurred.getTime() / 1000);
};

/**
 * Build a single Meta Purchase event from a resolved conversion row. A row
 * carrying a ctwa_clid came through click-to-WhatsApp: Meta only attributes
 * those when sent as action_source='business_messaging' with
 * messaging_channel='whatsapp' and the RAW ctwa_clid in user_data (a generic
 * 'website' event silently drops the CTWA attribution).
 */
export function buildPurchaseEvent(row: ConversionRow): MetaEvent {
  const userData: Record<string, unknown> = {};
  if (row.userId != null && String(row.userId) !== '') {
    userData.external_id = [sha256(String(row.userId))];
  }
  if (row.city) userData.ct = [sha256(row.city)];
  // fbc/fbp are cookie identifiers — sent RAW (never hashed) per Meta spec.
  if (row.fbc) userData.fbc = row.fbc;
  if (row.fbp) userData.fbp = row.fbp;

  const base = {
    event_name: 'Purchase' as const,
    event_time: toUnixSeconds(row.occurredAt), // unix SECONDS
    event_id: row.orderId, // dedup key with the browser pixel
    custom_data: { value: Number(row.valueInr), currency: 'INR' as const },
  };

  if (row.ctwaClid) {
    userData.ctwa_clid = row.ctwaClid; // RAW, never hashed (Meta spec)
    return {
      ...base,
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      user_data: userData,
    };
  }

  return { ...base, action_source: toActionSource(row.actionSource), user_data: userData };
}

export interface LeadEventRow {
  ctwaClid: string;
  waPhoneHash: string | null; // sha256 hex of digits-only phone — already Meta's ph format
  occurredAt: Date | string;
}

/**
 * Build a Meta Lead event for a qualified CTWA WhatsApp lead. event_id
 * 'lead-<ctwa_clid>' dedups retries server-side (one Lead per click), and the
 * business_messaging envelope + raw ctwa_clid are what make Meta attribute it
 * to the click-to-WhatsApp ad. wa_phone_hash is sha256 of the DIGITS-ONLY
 * phone with country code ('919876543210', no '+' — exactly Meta's `ph`
 * normalization rule; the producer hashes that form) — so it is forwarded
 * as-is, not re-hashed.
 */
export function buildLeadEvent(row: LeadEventRow): MetaEvent {
  const userData: Record<string, unknown> = { ctwa_clid: row.ctwaClid };
  if (row.waPhoneHash) userData.ph = [row.waPhoneHash];

  return {
    event_name: 'Lead',
    event_time: toUnixSeconds(row.occurredAt),
    event_id: `lead-${row.ctwaClid}`,
    action_source: 'business_messaging',
    messaging_channel: 'whatsapp',
    user_data: userData,
  };
}

export interface SendOptions {
  datasetId: string;
  token: string;
  version: string;
  testEventCode?: string;
}

export interface SendResult {
  ok: boolean;
  eventsReceived: number;
  error?: string;
}

/**
 * POST a batch of events to Meta's dataset /events endpoint. Mirrors the
 * geo-engine reliability contract: 30s timeout, one retry on 429/5xx. Never
 * throws — returns { ok:false, error } so the caller leaves rows unmarked and
 * retries next run.
 */
export async function sendEvents(
  events: MetaEvent[],
  opts: SendOptions,
): Promise<SendResult> {
  const url = `https://graph.facebook.com/${opts.version}/${opts.datasetId}/events?access_token=${encodeURIComponent(opts.token)}`;
  const body: Record<string, unknown> = { data: events };
  if (opts.testEventCode) body.test_event_code = opts.testEventCode;

  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };

  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      const msg = (err as Error).message;
      log.error({ err: msg }, 'CAPI request failed (network/timeout)');
      return { ok: false, eventsReceived: 0, error: msg };
    }

    const json = (await res.json().catch(() => ({}))) as {
      events_received?: number;
      error?: { message?: string };
    };

    if (res.ok && !json.error) {
      return { ok: true, eventsReceived: json.events_received ?? 0 };
    }

    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt === 1) {
      log.warn({ status: res.status }, 'CAPI request retryable — retrying once');
      await sleep(RETRY_DELAY_MS);
      continue;
    }

    const error = json.error?.message ?? `Meta CAPI ${res.status}`;
    log.error({ status: res.status, error }, 'CAPI request failed');
    return { ok: false, eventsReceived: 0, error };
  }
}
