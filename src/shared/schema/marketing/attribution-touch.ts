import { sql } from 'drizzle-orm';
import { bigint, text, boolean, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { marketing, idCol, appCol, appCheck } from './_shared.js';

/**
 * Click-ID / UTM touches — the attribution spine input. Click-ID columns are
 * sparse, so their indexes are partial (WHERE col IS NOT NULL). Deterministic
 * identifiers only; no fingerprinting (DPDP).
 */
export const attributionTouch = marketing.table(
  'attribution_touch',
  {
    id: idCol(),
    app: appCol(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    channel: text('channel'), // inferred from which click id is present
    fbclid: text('fbclid'),
    gclid: text('gclid'),
    gbraid: text('gbraid'),
    wbraid: text('wbraid'),
    fbc: text('fbc'),
    fbp: text('fbp'),
    ctwaClid: text('ctwa_clid'), // Meta CTWA click id from the WhatsApp referral
    waPhoneHash: text('wa_phone_hash'), // sha256 hex of E.164 phone (never raw — DPDP)
    utmSource: text('utm_source'),
    utmMedium: text('utm_medium'),
    utmCampaign: text('utm_campaign'),
    utmContent: text('utm_content'),
    utmTerm: text('utm_term'),
    // 'touch' | 'first_party_click' | 'lead' — first-party clicks/leads from
    // BackendNew's redirect + lead ingest share the touch spine (no new table).
    touchType: text('touch_type').notNull().default('touch'),
    sessionId: text('session_id'),
    userId: bigint('user_id', { mode: 'number' }), // resolved when identity known
    landingUrl: text('landing_url'),
    referrer: text('referrer'),
    consent: boolean('consent').notNull().default(false),
    raw: jsonb('raw'),
  },
  (t) => [
    index('idx_touch_gclid').on(t.app, t.gclid).where(sql`gclid is not null`),
    index('idx_touch_fbclid').on(t.app, t.fbclid).where(sql`fbclid is not null`),
    index('idx_touch_ctwa_clid').on(t.app, t.ctwaClid).where(sql`ctwa_clid is not null`),
    index('idx_touch_session')
      .on(t.app, t.sessionId, t.occurredAt.desc())
      .where(sql`session_id is not null`),
    index('idx_touch_user')
      .on(t.app, t.userId, t.occurredAt.desc())
      .where(sql`user_id is not null`),
    index('idx_touch_campaign')
      .on(t.app, t.utmCampaign, t.occurredAt.desc())
      .where(sql`utm_campaign is not null`),
    appCheck('touch_app_chk', t.app),
  ],
);
