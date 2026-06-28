import { sql } from 'drizzle-orm';
import {
  bigint,
  text,
  numeric,
  date,
  timestamp,
  index,
  primaryKey,
  check,
} from 'drizzle-orm/pg-core';
import { marketing, appCol } from './_shared.js';
import { adEntity } from './ad-entity.js';

/**
 * Daily performance facts. Composite PK (app, ad_entity_id, stat_date) doubles
 * as the idempotent upsert key — `app` leads the btree and satisfies the
 * "app in every unique key" rule with zero extra index.
 */
export const adPerformanceDaily = marketing.table(
  'ad_performance_daily',
  {
    app: appCol(),
    adEntityId: bigint('ad_entity_id', { mode: 'number' })
      .notNull()
      .references(() => adEntity.id),
    statDate: date('stat_date').notNull(),
    channel: text('channel').notNull(),
    spendInr: numeric('spend_inr', { precision: 14, scale: 2 }).notNull().default('0'),
    impressions: bigint('impressions', { mode: 'number' }).notNull().default(0),
    clicks: bigint('clicks', { mode: 'number' }).notNull().default(0),
    conversions: numeric('conversions', { precision: 14, scale: 2 }).notNull().default('0'),
    convValueInr: numeric('conv_value_inr', { precision: 14, scale: 2 }).notNull().default('0'),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.app, t.adEntityId, t.statDate] }),
    index('idx_perf_app_date').on(t.app, t.statDate),
    check('ad_perf_app_chk', sql`${t.app} in ('services','society')`),
  ],
);
