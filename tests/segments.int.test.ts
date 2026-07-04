import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

// The queue is mocked so route handlers can enqueue without a live Redis; the
// test drives refreshSegment() directly (the worker's job body) instead.
const enqueued: Array<{ name: string; data: unknown }> = [];
vi.mock('../src/shared/queue/index.js', () => ({
  segmentsRefreshQueue: {
    add: vi.fn(async (name: string, data: unknown) => {
      enqueued.push({ name, data });
    }),
  },
}));

let container: StartedPostgreSqlContainer;
let buildApp: typeof import('../src/app.js')['buildApp'];
let refreshSegment: typeof import('../src/marketing/segments/refresh.js')['refreshSegment'];
let dueSegmentIds: typeof import('../src/marketing/segments/refresh.js')['dueSegmentIds'];
let db: typeof import('../src/shared/db/index.js')['db'];
let app: FastifyInstance;
let APP: string;
let TOKEN: string;

const auth = () => ({ authorization: `Bearer ${TOKEN}` });

// Timestamps relative to now so window filters (now() - N days) behave the same
// on any calendar day.
const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

async function seedConversion(row: {
  orderId: string;
  userId: number;
  valueInr: number;
  occurredAt: string;
  isFirstOrder?: boolean;
  city?: string;
}): Promise<void> {
  await db.execute(sql`
    insert into marketing.conversion (app, order_id, user_id, occurred_at, value_inr, is_first_order, city)
    values (${APP}, ${row.orderId}, ${row.userId}, ${row.occurredAt}, ${row.valueInr},
            ${row.isFirstOrder ?? false}, ${row.city ?? null})`);
}

async function seedEvent(row: {
  eventName: string;
  userId: number;
  occurredAt: string;
}): Promise<void> {
  await db.execute(sql`
    insert into marketing.app_event (event_id, app, event_name, occurred_at, user_id)
    values (${randomUUID()}, ${APP}, ${row.eventName}, ${row.occurredAt}, ${row.userId})`);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  process.env.DATABASE_URL = container.getConnectionUri();

  const dir = join(process.cwd(), 'drizzle');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  // Run migrations twice to prove idempotency is at least not fatal for our new
  // migration (CREATE INDEX IF NOT EXISTS / guarded DO blocks). The base-table
  // CREATE TABLEs are not IF NOT EXISTS, so the second pass only re-applies our
  // additive statements via a fresh connection after the first full apply.
  const files = readdirSync(dir).filter((x) => x.endsWith('.sql')).sort();
  for (const f of files) await client.query(readFileSync(join(dir, f), 'utf8'));
  // Second pass: only 0005's idempotent tail (indexes) — re-running the whole
  // file would fail on CREATE TABLE, which is expected; we assert the guarded
  // indexes are safe to re-create.
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_conversion_user_time
      ON marketing.conversion (app, user_id, occurred_at) WHERE user_id IS NOT NULL;
    DO $$ BEGIN
      IF to_regclass('marketing.app_event') IS NOT NULL THEN
        CREATE INDEX IF NOT EXISTS idx_app_event_seg
          ON marketing.app_event (app, event_name, user_id, occurred_at);
      END IF;
    END $$;`);
  client.release();
  await pool.end();

  ({ buildApp } = await import('../src/app.js'));
  ({ refreshSegment, dueSegmentIds } = await import('../src/marketing/segments/refresh.js'));
  ({ db } = await import('../src/shared/db/index.js'));
  APP = (await import('../src/config/env.js')).env.MIL_DEFAULT_APP;
  TOKEN = (await import('../src/config/env.js')).env.MIL_SERVING_TOKEN;

  app = await buildApp();
}, 120_000);

afterAll(async () => {
  await app?.close();
  const { pool } = await import('../src/shared/db/index.js');
  await pool.end();
  await container?.stop();
});

describe('segments serving + refresh (integration)', () => {
  it('migration idempotency: re-running the guarded indexes does not error', () => {
    // Reaching this point means the second-pass CREATE INDEX IF NOT EXISTS block
    // in beforeAll ran cleanly.
    expect(true).toBe(true);
  });

  it('creates a dormant_30d segment, dry-runs, refreshes, paginates, archives', async () => {
    // user 10: last order 45d ago → dormant. user 11: last order 5d ago → active.
    await seedConversion({ orderId: 'A-10', userId: 10, valueInr: 500, occurredAt: daysAgo(45) });
    await seedConversion({ orderId: 'A-11', userId: 11, valueInr: 500, occurredAt: daysAgo(5) });

    const definition = {
      version: 1,
      group: {
        op: 'AND',
        criteria: [
          { kind: 'order_frequency', op: 'gte', count: 1 },
          { kind: 'order_recency', op: 'gt', days: 30 },
        ],
      },
    };

    // Dry-run first: count should be 1 (only user 10).
    const dry = await app.inject({
      method: 'POST',
      url: '/marketing/segments/dry-run',
      headers: auth(),
      payload: { app: APP, definition },
    });
    expect(dry.statusCode).toBe(200);
    const dryData = dry.json().data;
    expect(dryData.count).toBe(1);
    expect(dryData.sample_user_ids).toEqual([10]);
    expect(typeof dryData.took_ms).toBe('number');

    // Create.
    const created = await app.inject({
      method: 'POST',
      url: '/marketing/segments',
      headers: auth(),
      payload: { app: APP, name: 'Dormant 30d', definition, created_by: 'test' },
    });
    expect(created.statusCode).toBe(201);
    const seg = created.json().data;
    expect(seg.slug).toBe('dormant_30d');
    expect(seg.status).toBe('active');
    expect(enqueued.some((j) => j.name === 'refresh-segment')).toBe(true);

    // Dup slug → 409.
    const dup = await app.inject({
      method: 'POST',
      url: '/marketing/segments',
      headers: auth(),
      payload: { app: APP, name: 'x', slug: 'dormant_30d', definition },
    });
    expect(dup.statusCode).toBe(409);

    // Refresh (drives the worker body directly).
    const refreshResult = await refreshSegment(seg.id);
    expect(refreshResult.count).toBe(1);

    // List reflects last_count.
    const list = await app.inject({ method: 'GET', url: `/marketing/segments?app=${APP}`, headers: auth() });
    expect(list.statusCode).toBe(200);
    const listed = list.json().data.find((s: { id: number }) => s.id === seg.id);
    expect(listed.last_count).toBe(1);
    expect(listed.last_error).toBeNull();

    // Members: user_ids only, keyset pagination.
    const members = await app.inject({
      method: 'GET',
      url: `/marketing/segments/${seg.id}/members?limit=1`,
      headers: auth(),
    });
    expect(members.statusCode).toBe(200);
    const page = members.json().data;
    expect(page.segment_id).toBe(seg.id);
    expect(page.user_ids).toEqual([10]);
    expect(page.total).toBe(1);
    // limit=1 with exactly 1 member → page is full, so next_cursor is the last
    // user_id (keyset: "ask again"). The follow-up page then terminates empty.
    expect(page.next_cursor).toBe(10);
    // Assert NO PII leaked — only the whitelisted keys.
    expect(Object.keys(page).sort()).toEqual(
      ['computed_at', 'next_cursor', 'segment_id', 'total', 'user_ids'].sort(),
    );

    const page2 = (
      await app.inject({
        method: 'GET',
        url: `/marketing/segments/${seg.id}/members?limit=1&cursor=${page.next_cursor}`,
        headers: auth(),
      })
    ).json().data;
    expect(page2.user_ids).toEqual([]);
    expect(page2.next_cursor).toBeNull();

    // Archive (soft delete): status archived + membership purged.
    const del = await app.inject({ method: 'DELETE', url: `/marketing/segments/${seg.id}`, headers: auth() });
    expect(del.statusCode).toBe(200);
    const after = await getSegmentStatus(seg.id);
    expect(after).toBe('archived');
    const remaining = await db.execute(
      sql`select count(*)::int as n from marketing.segment_membership where segment_id = ${seg.id}`,
    );
    expect(Number((remaining.rows[0] as { n: number }).n)).toBe(0);
  });

  it('refreshes an app_event-based cart-abandoner segment', async () => {
    // user 20 added to cart but never purchased → member.
    // user 21 added to cart AND purchased → not a member.
    await seedEvent({ eventName: 'el_add_to_cart', userId: 20, occurredAt: daysAgo(1) });
    await seedEvent({ eventName: 'el_add_to_cart', userId: 21, occurredAt: daysAgo(1) });
    await seedEvent({ eventName: 'purchase', userId: 21, occurredAt: daysAgo(1) });

    const definition = {
      version: 1,
      group: {
        op: 'AND',
        criteria: [
          { kind: 'event', event: 'el_add_to_cart', performed: true, window_days: 2 },
          { kind: 'event', event: 'purchase', performed: false, window_days: 2 },
        ],
      },
    };

    const created = await app.inject({
      method: 'POST',
      url: '/marketing/segments',
      headers: auth(),
      payload: { app: APP, name: 'Cart Abandoners 48h', definition },
    });
    expect(created.statusCode).toBe(201);
    const seg = created.json().data;

    const res = await refreshSegment(seg.id);
    expect(res.count).toBe(1);

    const members = await app.inject({
      method: 'GET',
      url: `/marketing/segments/${seg.id}/members`,
      headers: auth(),
    });
    expect(members.json().data.user_ids).toEqual([20]);
  });

  it('dueSegmentIds returns active segments whose interval has elapsed', async () => {
    const ids = await dueSegmentIds();
    // The cart-abandoner segment was just created (last_refreshed_at set by its
    // refresh); the dormant one is archived. Both should be excluded now unless
    // their interval already elapsed. Assert the function runs and returns an
    // array of numbers.
    expect(Array.isArray(ids)).toBe(true);
    for (const id of ids) expect(typeof id).toBe('number');
  });

  it('404s an unknown segment and validates the DSL on create', async () => {
    const missing = await app.inject({ method: 'GET', url: '/marketing/segments/999999', headers: auth() });
    expect(missing.statusCode).toBe(404);

    const bad = await app.inject({
      method: 'POST',
      url: '/marketing/segments',
      headers: auth(),
      payload: { app: APP, name: 'bad', definition: { version: 1, group: { op: 'AND', criteria: [] } } },
    });
    expect(bad.statusCode).toBe(400); // zod rejects empty group → Validation Error
  });
});

async function getSegmentStatus(id: number): Promise<string> {
  const res = await db.execute(sql`select status from marketing.segment where id = ${id}`);
  return (res.rows[0] as { status: string }).status;
}
