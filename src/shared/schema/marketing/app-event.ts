import { sql } from 'drizzle-orm';
import { uuid, bigint, text, jsonb, timestamp, index, primaryKey } from 'drizzle-orm/pg-core';
import { marketing, appCol, appCheck } from './_shared.js';

/**
 * First-party product events (el_* taxonomy) — the raw behavioural stream behind
 * DAU / funnels / retention.
 *
 * DIVERGENCE FROM idCol(): no BIGINT identity here. The PK is the COMPOSITE
 * (event_id, occurred_at):
 *   - occurred_at is the partition key, and Postgres requires the partition key
 *     to be part of the PK on a RANGE-partitioned table (the physical table is
 *     partitioned monthly in drizzle/0004_app_event.sql — Drizzle need not, and
 *     does not, know about partitioning; it treats this as one plain table).
 *   - event_id is CLIENT-MINTED (UUID generated app-side before send), so the PK
 *     doubles as the idempotency key for `onConflictDoNothing` on batch re-POSTs.
 */
export const appEvent = marketing.table(
  'app_event',
  {
    eventId: uuid('event_id').notNull(),
    app: appCol(),
    eventName: text('event_name').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    sessionId: text('session_id'),
    userId: bigint('user_id', { mode: 'number' }),
    platform: text('platform'),
    appVersion: text('app_version'),
    props: jsonb('props'),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.occurredAt] }),
    index('idx_app_event_name').on(t.app, t.eventName, t.occurredAt),
    index('idx_app_event_user')
      .on(t.app, t.userId, t.occurredAt)
      .where(sql`user_id is not null`),
    index('idx_app_event_session')
      .on(t.app, t.sessionId, t.occurredAt)
      .where(sql`session_id is not null`),
    appCheck('app_event_app_chk', t.app),
  ],
);
