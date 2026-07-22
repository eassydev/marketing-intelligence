/**
 * Seed the system (is_system=true) behavioural segments, one set per app in
 * MIL_ENABLED_APPS. Idempotent: upserts on the natural key (app, slug) — re-runs
 * refresh the name/description/definition/interval without touching a segment's
 * refresh bookkeeping or membership.
 *
 * cart_abandoners_48h references marketing.app_event; if that table is absent on
 * this instance it is seeded status='paused' so the dispatcher skips it (an
 * operator can un-pause once app_event exists).
 */
import { sql } from 'drizzle-orm';
import { db } from '../src/shared/db/index.js';
import { env } from '../src/config/env.js';
import { definitionSchema, type Definition } from '../src/marketing/segments/dsl.js';
import { appEventAvailable } from '../src/marketing/segments/events-available.js';

interface SeedSpec {
  slug: string;
  name: string;
  description: string;
  definition: Definition;
  refreshIntervalMinutes: number;
  /** references app_event → paused when the table is absent. */
  needsEvents?: boolean;
}

const def = (d: unknown): Definition => definitionSchema.parse(d);

const SEEDS: SeedSpec[] = [
  {
    slug: 'new_users_7d',
    name: 'New users (first order ≤ 7d)',
    description: 'Placed their first order within the last 7 days.',
    refreshIntervalMinutes: 360,
    definition: def({
      version: 1,
      group: { op: 'AND', criteria: [{ kind: 'first_order_age', op: 'lte', days: 7 }] },
    }),
  },
  {
    slug: 'dormant_30d',
    name: 'Dormant 30d',
    description: 'Ordered at least once but not in the last 30 days.',
    refreshIntervalMinutes: 360,
    definition: def({
      version: 1,
      group: {
        op: 'AND',
        criteria: [
          { kind: 'order_frequency', op: 'gte', count: 1 },
          { kind: 'order_recency', op: 'gt', days: 30 },
        ],
      },
    }),
  },
  {
    slug: 'dormant_90d',
    name: 'Dormant 90d',
    description: 'Ordered at least once but not in the last 90 days.',
    refreshIntervalMinutes: 720,
    definition: def({
      version: 1,
      group: {
        op: 'AND',
        criteria: [
          { kind: 'order_frequency', op: 'gte', count: 1 },
          { kind: 'order_recency', op: 'gt', days: 90 },
        ],
      },
    }),
  },
  {
    slug: 'repeat_buyers',
    name: 'Repeat buyers',
    description: 'Two or more orders (lifetime).',
    refreshIntervalMinutes: 360,
    definition: def({
      version: 1,
      group: { op: 'AND', criteria: [{ kind: 'order_frequency', op: 'gte', count: 2 }] },
    }),
  },
  {
    slug: 'high_value',
    name: 'High value (top 10% LTV)',
    description: 'Lifetime spend in the top 10% (≥ 90th percentile).',
    refreshIntervalMinutes: 720,
    definition: def({
      version: 1,
      group: { op: 'AND', criteria: [{ kind: 'ltv_percentile', op: 'gte', percentile: 90 }] },
    }),
  },
  {
    slug: 'cart_abandoners_48h',
    name: 'Cart abandoners (48h)',
    description: 'Added to cart in the last 48h but did not purchase.',
    refreshIntervalMinutes: 180,
    needsEvents: true,
    definition: def({
      version: 1,
      group: {
        op: 'AND',
        criteria: [
          { kind: 'event', event: 'el_add_to_cart', performed: true, window_days: 2 },
          // 'charged' is what the services checkout actually emits
          // (appEventServices.dart onBookingSuccessfulEvent); 'purchase' exists
          // only on the flights screen. Negating a name that never fires made
          // the EXCEPT subtract nothing, so this segment silently included
          // people who had already bought.
          { kind: 'event', event: 'charged', performed: false, window_days: 2 },
        ],
      },
    }),
  },
];

async function seed(): Promise<void> {
  const eventsAvailable = await appEventAvailable();
  const apps = env.MIL_ENABLED_APPS;
  let upserts = 0;

  for (const app of apps) {
    for (const spec of SEEDS) {
      const status = spec.needsEvents && !eventsAvailable ? 'paused' : 'active';
      await db.execute(sql`
        insert into marketing.segment
          (app, slug, name, description, definition, refresh_interval_minutes, status, is_system)
        values (
          ${app}, ${spec.slug}, ${spec.name}, ${spec.description},
          ${JSON.stringify(spec.definition)}::jsonb, ${spec.refreshIntervalMinutes}, ${status}, true
        )
        on conflict (app, slug) do update set
          name = excluded.name,
          description = excluded.description,
          definition = excluded.definition,
          refresh_interval_minutes = excluded.refresh_interval_minutes,
          updated_at = now()`);
      upserts += 1;
    }
  }
  console.log(`seed-segments complete — ${upserts} segment(s) upserted across ${apps.length} app(s)`);
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
