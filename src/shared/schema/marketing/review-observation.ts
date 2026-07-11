import { text, integer, numeric, date, jsonb, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { marketing, idCol, appCol, createdAtCol, appCheck } from './_shared.js';

/**
 * Daily store / Google-Business review snapshots (Phase 6 — brand health).
 * One row per (app, source, snapshot_date), written by mil-reviews-ingest.
 * Stores expose no reviewer↔booking identity, so this is a brand-level trend,
 * not per-campaign attribution.
 *
 * NOTE — the source CHECK is mirrored verbatim in drizzle/0008_reviews.sql
 * (which migrates the LIVE database); keep the two in sync.
 */
export const reviewObservation = marketing.table(
  'review_observation',
  {
    id: idCol(),
    app: appCol(),
    source: text('source').notNull(), // 'google_business' | 'play_store' | 'app_store'
    snapshotDate: date('snapshot_date').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    ratingAvg: numeric('rating_avg', { precision: 3, scale: 2 }),
    ratingCount: integer('rating_count'),
    newReviewsCount: integer('new_reviews_count'),
    raw: jsonb('raw'),
    createdAt: createdAtCol(),
  },
  (t) => [
    uniqueIndex('uq_review_obs').on(t.app, t.source, t.snapshotDate),
    appCheck('review_obs_app_chk', t.app),
  ],
);
