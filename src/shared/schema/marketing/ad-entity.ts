import { sql } from 'drizzle-orm';
import { text, numeric, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { marketing, idCol, appCol, createdAtCol, updatedAtCol, appCheck } from './_shared.js';

/** Normalized campaign/adset/ad tree, reconciled across Meta + Google. */
export const adEntity = marketing.table(
  'ad_entity',
  {
    id: idCol(),
    app: appCol(),
    channel: text('channel').notNull(), // 'meta' | 'google'
    level: text('level').notNull(), // 'campaign' | 'adset' | 'ad'
    externalId: text('external_id').notNull(),
    parentExternalId: text('parent_external_id'),
    name: text('name'),
    city: text('city'), // parsed from {city}_{category}_{objective}
    category: text('category'),
    objective: text('objective'),
    status: text('status'),
    currentDailyBudgetInr: numeric('current_daily_budget_inr', { precision: 14, scale: 2 }),
    currency: text('currency'), // asserted INR at ingest
    raw: jsonb('raw'),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    uniqueIndex('uq_ad_entity').on(t.app, t.channel, t.level, t.externalId),
    index('idx_ad_entity_channel_level').on(t.app, t.channel, t.level),
    index('idx_ad_entity_city_cat').on(t.app, t.city, t.category),
    appCheck('ad_entity_app_chk', t.app),
  ],
);
