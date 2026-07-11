import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../shared/db/index.js';
import { attributionTouch, identityLink } from '../../shared/schema/index.js';
import type { TouchIngest } from './validators.js';

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

/**
 * Write a touch. When identity is known (server-side forward), record the
 * session→user link and backfill earlier anonymous touches for that session —
 * the session_id → user_id stitch.
 */
export async function writeTouch(p: TouchIngest): Promise<void> {
  await db.insert(attributionTouch).values({
    app: p.app,
    occurredAt: p.occurred_at ? new Date(p.occurred_at) : new Date(),
    channel: p.channel ?? inferChannel(p), // explicit (e.g. 'ctwa') wins over inference
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
}
