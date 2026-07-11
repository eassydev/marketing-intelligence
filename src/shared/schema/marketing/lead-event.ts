import { sql } from 'drizzle-orm';
import { text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { marketing, idCol, appCol, createdAtCol, appCheck } from './_shared.js';

/**
 * CTWA Lead events (Phase 6 — §D CAPI). One row per (app, ctwa_clid), written
 * by POST /ingest/lead-event when a WhatsApp conversation qualifies. The
 * mil-capi-meta job uploads unsent rows to Meta as 'Lead' events with
 * action_source='business_messaging' and marks capi_uploaded_at (the partial
 * index is its work queue).
 */
export const leadEvent = marketing.table(
  'lead_event',
  {
    id: idCol(),
    app: appCol(),
    ctwaClid: text('ctwa_clid').notNull(),
    waPhoneHash: text('wa_phone_hash'), // sha256 hex of digits-only phone incl. country code (Meta ph form; never raw — DPDP)
    leadRef: text('lead_ref'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    capiUploadedAt: timestamp('capi_uploaded_at', { withTimezone: true }),
    createdAt: createdAtCol(),
  },
  (t) => [
    uniqueIndex('uq_lead_event').on(t.app, t.ctwaClid),
    index('idx_lead_event_capi_pending')
      .on(t.app, t.occurredAt)
      .where(sql`capi_uploaded_at is null`),
    appCheck('lead_event_app_chk', t.app),
  ],
);
