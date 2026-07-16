import { sql } from 'drizzle-orm';
import { text, boolean, uniqueIndex, check } from 'drizzle-orm/pg-core';
import {
  marketing,
  idCol,
  appCol,
  appCheck,
  createdAtCol,
  updatedAtCol,
} from './_shared.js';

/**
 * Event definitions registry — one row per (app, source, event_name) with the
 * human description + expected cadence that the events monitor uses to grade a
 * stream ok/stale/muted/unregistered. event_name '' (the default) marks a
 * WHOLE-STREAM row (click/lead/conversion/touch have no per-event names); an
 * empty string instead of NULL keeps the UNIQUE constraint airtight.
 *
 * 'notification'/'web' sources register here too but are counted by
 * BackendNew's engagement overview, not MIL.
 *
 * NOTE — the source/frequency CHECKs are mirrored verbatim in
 * drizzle/0010_event_registry.sql (which migrates the LIVE database); keep the
 * two in sync.
 */
export const eventRegistry = marketing.table(
  'event_registry',
  {
    id: idCol(),
    // DEFAULT 'services' mirrors the hand-authored migration; edit both when
    // cloning for a new marketplace (see NEW_INSTANCE.md).
    app: appCol().default('services'),
    source: text('source').notNull(),
    eventName: text('event_name').notNull().default(''), // '' = whole-stream row
    description: text('description'),
    expectedFrequency: text('expected_frequency').notNull().default('none'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    uniqueIndex('uq_event_registry').on(t.app, t.source, t.eventName),
    check(
      'event_registry_source_chk',
      sql`${t.source} in ('app','click','lead','conversion','touch','notification','web')`,
    ),
    check(
      'event_registry_frequency_chk',
      sql`${t.expectedFrequency} in ('none','hourly','daily','weekly')`,
    ),
    appCheck('event_registry_app_chk', t.app),
  ],
);
