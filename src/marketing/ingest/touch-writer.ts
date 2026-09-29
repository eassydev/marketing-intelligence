import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../shared/db/index.js';
import { env } from '../../config/env.js';
import { createChildLogger } from '../../shared/logger/index.js';
import { attributionTouch, identityLink } from '../../shared/schema/index.js';
import {
  applyMetaInstallReferrer,
  decryptMetaInstallReferrer,
  type MetaReferrerResult,
} from '../attribution/meta-install-referrer.js';
import type { TouchIngest } from './validators.js';

const log = createChildLogger({ module: 'touch-writer' });

/** Meta's generic Play-referrer labels (Facebook / Instagram for Android). */
export const META_GENERIC_LABELS = ['fb4a', 'ig4a'] as const;

const isGenericMetaLabel = (value: string | null | undefined): boolean =>
  !!value && (META_GENERIC_LABELS as readonly string[]).includes(value.toLowerCase());

/** Infer channel from whichever click id is present. */
export function inferChannel(t: {
  gclid?: string | null;
  gbraid?: string | null;
  wbraid?: string | null;
  fbclid?: string | null;
  fbc?: string | null;
}): string | null {
  if (t.gclid || t.gbraid || t.wbraid) return 'google';
  if (t.fbclid || t.fbc) return 'meta';
  return null;
}

let warnedNoKey = false;

function logMetaReferrerOutcome(result: MetaReferrerResult, touch: TouchIngest): void {
  const ctx = { touchType: touch.touch_type, utmSource: touch.utm_source, referrerLen: touch.referrer?.length ?? 0 };
  switch (result.status) {
    case 'no_key':
      if (!warnedNoKey) {
        warnedNoKey = true;
        log.warn(ctx, 'Meta install referrers are arriving but META_INSTALL_REFERRER_KEY is not set — they stay fb4a/ig4a');
      }
      return;
    case 'decrypt_failed':
      log.warn(ctx, 'Meta install referrer failed GCM decryption — wrong META_INSTALL_REFERRER_KEY or tampered data');
      return;
    case 'no_ids':
      log.warn(ctx, 'Meta install referrer decrypted but carried no usable campaign/ad set/ad id');
      return;
    case 'malformed':
      log.warn(ctx, 'Referrer mentions a Meta envelope but it could not be parsed (truncated or re-encoded?)');
      return;
    default:
      return;
  }
}

type MetaIds = Pick<TouchIngest, 'utm_campaign' | 'utm_term' | 'utm_content'>;

/**
 * Copy decrypted Meta ids onto the same session's touches that still carry a
 * generic fb4a/ig4a label. Same session = same install on the same device, so
 * this is an identity-proven correction, not an inference: it fixes install
 * touches that reached MIL without the encrypted payload (the edge Worker used
 * to drop it) once that user's registration forward brings it. A sibling's own
 * utm_term/utm_content survive when the decrypted envelope lacks that level.
 * Returns the number of rows corrected.
 */
export async function propagateMetaReferrerToSession(
  app: string,
  sessionId: string,
  decrypted: MetaIds,
): Promise<number> {
  const res = await db.execute(sql`
    update marketing.attribution_touch
       set utm_campaign = ${decrypted.utm_campaign ?? null},
           utm_term = coalesce(${decrypted.utm_term ?? null}, utm_term),
           utm_content = coalesce(${decrypted.utm_content ?? null}, utm_content),
           channel = coalesce(channel, 'meta'),
           raw = coalesce(raw, '{}'::jsonb) || jsonb_build_object(
             'meta_install_referrer', jsonb_build_object(
               'propagated', true,
               'original', jsonb_build_object(
                 'utm_source', utm_source, 'utm_campaign', utm_campaign,
                 'utm_term', utm_term, 'utm_content', utm_content)))
     where app = ${app}
       and session_id = ${sessionId}
       and lower(utm_campaign) in ('fb4a', 'ig4a')
       and raw -> 'meta_install_referrer' is null`);
  return res.rowCount ?? 0;
}

/**
 * The reverse order: a generic fb4a/ig4a touch without an envelope arrives
 * after the same session already produced a decrypted one — take its ids.
 */
async function withSessionMetaIds(touch: TouchIngest): Promise<TouchIngest> {
  if (!isGenericMetaLabel(touch.utm_campaign)) return touch;
  const res = await db.execute(sql`
    select utm_campaign, utm_term, utm_content
      from marketing.attribution_touch
     where app = ${touch.app}
       and session_id = ${touch.session_id}
       and raw -> 'meta_install_referrer' ->> 'nonce' is not null
     order by id
     limit 1`);
  const known = res.rows[0] as MetaIds | undefined;
  if (!known?.utm_campaign) return touch;
  return {
    ...touch,
    utm_campaign: known.utm_campaign,
    utm_term: known.utm_term ?? touch.utm_term ?? null,
    utm_content: known.utm_content ?? touch.utm_content ?? null,
    channel: touch.channel ?? 'meta',
    raw: {
      ...(touch.raw ?? {}),
      meta_install_referrer: {
        propagated: true,
        original: {
          utm_source: touch.utm_source ?? null,
          utm_campaign: touch.utm_campaign ?? null,
          utm_term: touch.utm_term ?? null,
          utm_content: touch.utm_content ?? null,
        },
      },
    },
  };
}

/** Best-effort enrichment: a failure here must never fail the ingest request. */
async function resolveMetaIds(input: TouchIngest, meta: MetaReferrerResult): Promise<TouchIngest> {
  if (meta.status === 'ok') return applyMetaInstallReferrer(input, meta);
  try {
    return await withSessionMetaIds(input);
  } catch (err) {
    log.error({ err }, 'session lookup for Meta ids failed — touch kept as received');
    return input;
  }
}

/**
 * Write a touch. When identity is known (server-side forward), record the
 * session→user link and backfill earlier anonymous touches for that session —
 * the session_id → user_id stitch. Meta app-ad install referrers are decrypted
 * first so the touch carries the real campaign instead of fb4a/ig4a.
 */
export async function writeTouch(input: TouchIngest): Promise<void> {
  const meta = decryptMetaInstallReferrer(input, env.META_INSTALL_REFERRER_KEY);
  logMetaReferrerOutcome(meta, input);
  const p = await resolveMetaIds(input, meta);

  await db.insert(attributionTouch).values({
    app: p.app,
    occurredAt: p.occurred_at ? new Date(p.occurred_at) : new Date(),
    channel: p.channel ?? inferChannel(p), // explicit (e.g. 'ctwa') wins over inference
    touchType: p.touch_type ?? 'touch',
    gclid: p.gclid ?? null,
    fbclid: p.fbclid ?? null,
    gbraid: p.gbraid ?? null,
    wbraid: p.wbraid ?? null,
    fbc: p.fbc ?? null,
    fbp: p.fbp ?? null,
    ctwaClid: p.ctwa_clid ?? null,
    waPhoneHash: p.wa_phone_hash ?? null,
    utmSource: p.utm_source ?? null,
    utmMedium: p.utm_medium ?? null,
    utmCampaign: p.utm_campaign ?? null,
    utmContent: p.utm_content ?? null,
    utmTerm: p.utm_term ?? null,
    sessionId: p.session_id,
    userId: p.user_id ?? null,
    landingUrl: p.landing_url ?? null,
    referrer: p.referrer ?? null,
    consent: p.consent,
    raw: p.raw ?? null,
  });

  if (p.user_id != null) {
    await db
      .insert(identityLink)
      .values({ app: p.app, sessionId: p.session_id, userId: p.user_id })
      .onConflictDoNothing({
        target: [identityLink.app, identityLink.sessionId, identityLink.userId],
      });
    await db
      .update(attributionTouch)
      .set({ userId: p.user_id })
      .where(
        and(
          eq(attributionTouch.app, p.app),
          eq(attributionTouch.sessionId, p.session_id),
          isNull(attributionTouch.userId),
        ),
      );
  }

  if (meta.status === 'ok') {
    try {
      await propagateMetaReferrerToSession(p.app, p.session_id, p);
    } catch (err) {
      // The touch itself is committed; a retry would duplicate it. The
      // backfill job re-runs this correction idempotently.
      log.error({ err }, 'Meta id propagation to same-session touches failed');
    }
  }
}
