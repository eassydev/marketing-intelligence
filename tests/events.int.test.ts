import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { EventsIngest } from '../src/marketing/ingest/validators.js';

// Integration: real Postgres via Testcontainers. Sets DATABASE_URL BEFORE
// importing any module that reads config/env, then dynamic-imports.
let container: StartedPostgreSqlContainer;
let writeEvents: (p: EventsIngest) => Promise<{ received: number; inserted: number }>;
let events: typeof import('../src/marketing/serving/event-queries.js');
let db: typeof import('../src/shared/db/index.js')['db'];
let schema: typeof import('../src/shared/schema/index.js');
let APP: string;

// Dates are computed RELATIVE TO NOW so writeEvents' [now-30d, now+1h] clamp is
// always a no-op regardless of the calendar day the suite runs. `base` is 20
// days ago; `day(n)` is n days after base (n in 0..~19 stays in-window). Each
// event is stamped 06:00 UTC = 11:30 IST — safely inside the IST calendar day,
// so cohort_date / DAU day-bucketing is unambiguous.
const NOW = new Date();
const base = new Date(NOW.getTime() - 20 * 24 * 60 * 60 * 1000);
/** YYYY-MM-DD for base + n days. */
function day(n: number): string {
  const d = new Date(base.getTime() + n * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}
const at = (date: string) => `${date}T06:00:00.000Z`;

async function seed(rows: Array<Record<string, unknown>>): Promise<void> {
  await writeEvents({ app: APP, events: rows } as unknown as EventsIngest);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  process.env.DATABASE_URL = container.getConnectionUri();

  const dir = join(process.cwd(), 'drizzle');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await client.query(readFileSync(join(dir, f), 'utf8'));
  }
  client.release();
  await pool.end();

  ({ writeEvents } = await import('../src/marketing/ingest/event-writer.js'));
  events = await import('../src/marketing/serving/event-queries.js');
  ({ db } = await import('../src/shared/db/index.js'));
  schema = await import('../src/shared/schema/index.js');
  APP = (await import('../src/config/env.js')).env.MIL_DEFAULT_APP;
}, 120_000);

afterAll(async () => {
  const { pool } = await import('../src/shared/db/index.js');
  await pool.end();
  await container?.stop();
});

describe('app_event ingest + serving (integration)', () => {
  it('lands a batch and dedups an identical re-POST', async () => {
    const e1 = randomUUID();
    const e2 = randomUUID();
    const batch: EventsIngest = {
      app: APP,
      events: [
        { event_id: e1, event_name: 'el_app_open', occurred_at: at(day(0)), session_id: 'sA', user_id: 100 },
        { event_id: e2, event_name: 'el_view_service', occurred_at: at(day(0)), session_id: 'sA', user_id: 100 },
      ],
    } as EventsIngest;

    const first = await writeEvents(batch);
    expect(first).toEqual({ received: 2, inserted: 2 });

    const rows = await db.execute(sql`select count(*)::int as n from marketing.app_event`);
    expect(Number((rows.rows[0] as { n: number }).n)).toBe(2);

    // Re-POST → idempotent, nothing new inserted.
    const second = await writeEvents(batch);
    expect(second).toEqual({ received: 2, inserted: 0 });
  });

  it('writes an identity_link row for a (session_id, user_id) batch', async () => {
    await seed([
      { event_id: randomUUID(), event_name: 'el_app_open', occurred_at: at(day(1)), session_id: 'sLink', user_id: 200 },
    ]);
    const links = await db
      .select()
      .from(schema.identityLink)
      .where(sql`session_id = 'sLink' and user_id = 200`);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ app: APP, sessionId: 'sLink', userId: 200 });
  });

  it('funnel counts an ordered 3-step journey and ignores out-of-order', async () => {
    // user 300: clean ordered journey open→view→book across three days.
    await seed([
      { event_id: randomUUID(), event_name: 'el_f_open', occurred_at: at(day(5)), user_id: 300 },
      { event_id: randomUUID(), event_name: 'el_f_view', occurred_at: at(day(6)), user_id: 300 },
      { event_id: randomUUID(), event_name: 'el_f_book', occurred_at: at(day(7)), user_id: 300 },
    ]);
    // user 301: open then view but never books → drops at step 3.
    await seed([
      { event_id: randomUUID(), event_name: 'el_f_open', occurred_at: at(day(5)), user_id: 301 },
      { event_id: randomUUID(), event_name: 'el_f_view', occurred_at: at(day(6)), user_id: 301 },
    ]);
    // user 302: books BEFORE viewing (out of order) → view must not count the
    // later step; book happened before view so book(after view) = none.
    await seed([
      { event_id: randomUUID(), event_name: 'el_f_open', occurred_at: at(day(5)), user_id: 302 },
      { event_id: randomUUID(), event_name: 'el_f_book', occurred_at: at(day(6)), user_id: 302 },
      { event_id: randomUUID(), event_name: 'el_f_view', occurred_at: at(day(7)), user_id: 302 },
    ]);

    const f = { app: APP, from: day(5), to: day(7) };
    const steps = await events.funnel(f, ['el_f_open', 'el_f_view', 'el_f_book']);
    // step1 open: users 300,301,302 = 3
    expect(steps[0]).toMatchObject({ step: 1, event_name: 'el_f_open', users: 3, pct_of_first: 100 });
    // step2 view(after open): 300,301 view day+6 (after open); 302 views day+7 (after open) = 3
    expect(steps[1]!.users).toBe(3);
    // step3 book(after view): only 300 books after viewing. 302 booked before viewing → excluded.
    expect(steps[2]).toMatchObject({ step: 3, event_name: 'el_f_book', users: 1 });
    expect(steps[2]!.pct_of_first).toBe(round(1 / 3));
  });

  it('retention d1 reflects a seeded cohort returning the next day', async () => {
    // user 400: active on cohort day (day+8) and again on d1 (day+9).
    await seed([
      { event_id: randomUUID(), event_name: 'el_r_open', occurred_at: at(day(8)), user_id: 400 },
      { event_id: randomUUID(), event_name: 'el_r_open', occurred_at: at(day(9)), user_id: 400 },
    ]);
    // user 401: active on cohort day only → not retained on d1.
    await seed([
      { event_id: randomUUID(), event_name: 'el_r_open', occurred_at: at(day(8)), user_id: 401 },
    ]);

    const f = { app: APP, from: day(8), to: day(18) };
    const ret = await events.retention(f, [1, 7], 'first_seen');
    // cohort_date is the IST calendar date; day(8) at 11:30 IST lands on day(8).
    const cohort = ret.cohorts.find((c) => c.cohort_date === day(8));
    expect(cohort).toBeTruthy();
    expect(cohort!.size).toBe(2);
    expect(cohort!.retained.d1).toBe(1); // only user 400 returned on d1
    expect(cohort!.rates.d1).toBe(round(1 / 2));
  });

  it('dau counts distinct stitched identities (session collapses into user)', async () => {
    // A single user 500 acts anonymously (session sX) then logged-in (user_id)
    // on the SAME day. identity_link stitches sX→500 so DAU counts them ONCE.
    await db
      .insert(schema.identityLink)
      .values({ app: APP, sessionId: 'sX', userId: 500 })
      .onConflictDoNothing();
    await seed([
      { event_id: randomUUID(), event_name: 'el_d_open', occurred_at: at(day(15)), session_id: 'sX' },
      { event_id: randomUUID(), event_name: 'el_d_open', occurred_at: at(day(15)), user_id: 500 },
      // a genuinely different anonymous user
      { event_id: randomUUID(), event_name: 'el_d_open', occurred_at: at(day(15)), session_id: 'sY' },
    ]);

    const f = { app: APP, from: day(15), to: day(15) };
    const d = await events.dau(f);
    const dayRow = d.daily.find((r) => r.date === day(15));
    expect(dayRow).toBeTruthy();
    // Two identities: {user 500 (via sX + direct)} + {sid:sY}. The two sX/500
    // rows collapse into one; sY is one. = 2.
    expect(dayRow!.dau).toBe(2);
    expect(dayRow!.events).toBe(3); // three raw events
  });
});

/** Match the query layer's 2-decimal percentage rounding. */
function round(fraction: number): number {
  return Math.round(fraction * 100 * 100) / 100;
}
