import { sql } from 'drizzle-orm';
import {
  bigint,
  text,
  jsonb,
  boolean,
  integer,
  timestamp,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from 'drizzle-orm/pg-core';
import {
  marketing,
  idCol,
  appCol,
  appCheck,
  createdAtCol,
  updatedAtCol,
} from './_shared.js';

/**
 * Behavioural segment definition. `definition` is the versioned criteria DSL
 * (see src/marketing/segments/dsl.ts) compiled to SQL by the refresh engine; the
 * materialised membership lives in segment_membership. `meta_audience_id` is a
 * forward seam for pushing a segment to a Meta CAPI Custom Audience.
 *
 * NOTE — the status CHECK is mirrored verbatim in drizzle/0005_segments.sql
 * (which migrates the LIVE database); keep the two in sync.
 */
export const segment = marketing.table(
  'segment',
  {
    id: idCol(),
    app: appCol(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    definition: jsonb('definition').notNull(),
    refreshIntervalMinutes: integer('refresh_interval_minutes').notNull().default(360),
    status: text('status').notNull().default('active'),
    isSystem: boolean('is_system').notNull().default(false),
    createdBy: text('created_by'),
    lastRefreshedAt: timestamp('last_refreshed_at', { withTimezone: true }),
    lastRefreshMs: integer('last_refresh_ms'),
    lastCount: integer('last_count'),
    lastError: text('last_error'),
    metaAudienceId: text('meta_audience_id'),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    uniqueIndex('uq_segment_slug').on(t.app, t.slug),
    index('idx_segment_status').on(t.app, t.status),
    check('segment_status_chk', sql`${t.status} in ('active','paused','archived')`),
    appCheck('segment_app_chk', t.app),
  ],
);

/**
 * Materialised membership: one row per (segment, user). Fully rebuilt each
 * refresh inside a single transaction (DELETE + INSERT), so it always reflects
 * the last successful compile of the parent segment's definition.
 */
export const segmentMembership = marketing.table(
  'segment_membership',
  {
    segmentId: bigint('segment_id', { mode: 'number' })
      .notNull()
      .references(() => segment.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.segmentId, t.userId] })],
);
