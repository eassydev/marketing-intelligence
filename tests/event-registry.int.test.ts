import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

// buildApp registers segmentsRoutes, whose queue import would dial Redis — mock
// it exactly as segments.int.test.ts does (this suite never enqueues anything).
vi.mock('../src/shared/queue/index.js', () => ({
  segmentsRefreshQueue: { add: vi.fn(async () => {}) },
}));

let container: StartedPostgreSqlContainer;
let db: typeof import('../src/shared/db/index.js')['db'];
let app: FastifyInstance;
let APP: string;
let TOKEN: string;

const auth = () => ({ authorization: `Bearer ${TOKEN}` });

/** now - n hours, ISO. Counters are now()-relative, so seeds are too. */
const hoursAgo = (n: number): string => new Date(Date.now() - n * 3_600_000).toISOString();

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

  const { buildApp } = await import('../src/app.js');
  ({ db } = await import('../src/shared/db/index.js'));
  APP = (await import('../src/config/env.js')).env.MIL_DEFAULT_APP;
  TOKEN = (await import('../src/config/env.js')).env.MIL_SERVING_TOKEN;
  app = await buildApp();

  // One fixture per stream. The first_party_click carries ip_hash in `raw` to
  // prove /recent whitelists it away; the plain touch carries a gclid to prove
  // only its PRESENCE is exposed.
  await db.execute(sql`
    insert into marketing.app_event (event_id, app, event_name, occurred_at, session_id, user_id, platform, props)
    values (${randomUUID()}, ${APP}, 'el_home_view', ${hoursAgo(1)}, 's1', 1, 'android', '{"screen":"home"}'::jsonb),
           (${randomUUID()}, ${APP}, 'el_checkout', ${hoursAgo(3)}, 's2', 2, 'ios', null)`);
  await db.execute(sql`
    insert into marketing.attribution_touch (app, occurred_at, touch_type, session_id, raw)
    values (${APP}, ${hoursAgo(2)}, 'first_party_click', 'c1',
            '{"link_id": 5, "is_bot": false, "device": "mobile", "ip_hash": "deadbeef"}'::jsonb)`);
  await db.execute(sql`
    insert into marketing.attribution_touch (app, occurred_at, touch_type, session_id, gclid, utm_source, utm_campaign, channel)
    values (${APP}, ${hoursAgo(1)}, 'touch', 't1', 'g-secret-1', 'google', 'diwali', 'google')`);
  await db.execute(sql`
    insert into marketing.conversion (app, order_id, user_id, occurred_at, value_inr, is_first_order, session_id)
    values (${APP}, 'O-1', 3, ${hoursAgo(1)}, 499.50, true, 's3')`);
  await db.execute(sql`
    insert into marketing.lead_event (app, ctwa_clid, lead_ref, occurred_at)
    values (${APP}, 'clid-1', 'L-1', ${hoursAgo(1)})`);
}, 120_000);

afterAll(async () => {
  await app?.close();
  const { pool } = await import('../src/shared/db/index.js');
  await pool.end();
  await container?.stop();
});

async function createRegistry(body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/marketing/events/registry', headers: auth(), payload: body });
}

describe('event registry CRUD (integration)', () => {
  it('rejects requests without the serving token', async () => {
    for (const url of ['/marketing/events/registry', '/marketing/events/overview', '/marketing/events/recent?source=app']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
    }
  });

  it('creates rows, 409s a duplicate, lists, updates, deletes', async () => {
    const created = await createRegistry({
      source: 'app',
      event_name: 'el_home_view',
      description: 'Home screen view',
      expected_frequency: 'hourly',
    });
    expect(created.statusCode).toBe(201);
    const row = created.json().data;
    expect(row).toMatchObject({
      app: APP,
      source: 'app',
      event_name: 'el_home_view',
      description: 'Home screen view',
      expected_frequency: 'hourly',
      is_active: true,
    });
    expect(typeof row.id).toBe('number');
    expect(Object.keys(row).sort()).toEqual(
      ['id', 'app', 'source', 'event_name', 'description', 'expected_frequency', 'is_active', 'created_at', 'updated_at'].sort(),
    );

    // Duplicate (app, source, event_name) → 409.
    const dup = await createRegistry({ source: 'app', event_name: 'el_home_view' });
    expect(dup.statusCode).toBe(409);

    // Whole-stream row: event_name defaults to ''.
    const click = await createRegistry({ source: 'click', expected_frequency: 'daily' });
    expect(click.statusCode).toBe(201);
    expect(click.json().data.event_name).toBe('');
    // A second whole-stream row for the same source collides on ''.
    expect((await createRegistry({ source: 'click' })).statusCode).toBe(409);

    // List is ordered by (source, event_name).
    const list = await app.inject({ method: 'GET', url: `/marketing/events/registry?app=${APP}`, headers: auth() });
    expect(list.statusCode).toBe(200);
    const rows = list.json().data;
    expect(rows.length).toBe(2);
    expect(rows.map((r: { source: string }) => r.source)).toEqual(['app', 'click']);

    // Partial update.
    const upd = await app.inject({
      method: 'PUT',
      url: `/marketing/events/registry/${row.id}`,
      headers: auth(),
      payload: { expected_frequency: 'daily', description: null },
    });
    expect(upd.statusCode).toBe(200);
    expect(upd.json().data).toMatchObject({ expected_frequency: 'daily', description: null, event_name: 'el_home_view' });

    // Rename onto an existing (app, source, event_name) → 409.
    const other = await createRegistry({ source: 'app', event_name: 'el_tmp' });
    const clash = await app.inject({
      method: 'PUT',
      url: `/marketing/events/registry/${other.json().data.id}`,
      headers: auth(),
      payload: { event_name: 'el_home_view' },
    });
    expect(clash.statusCode).toBe(409);

    // Delete + 404s.
    const del = await app.inject({ method: 'DELETE', url: `/marketing/events/registry/${other.json().data.id}`, headers: auth() });
    expect(del.statusCode).toBe(200);
    expect(del.json().data).toEqual({ deleted: true });
    expect((await app.inject({ method: 'DELETE', url: `/marketing/events/registry/${other.json().data.id}`, headers: auth() })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: '/marketing/events/registry/999999', headers: auth(), payload: { is_active: false } })).statusCode).toBe(404);

    // Restore el_home_view to hourly for the overview test below.
    await app.inject({
      method: 'PUT',
      url: `/marketing/events/registry/${row.id}`,
      headers: auth(),
      payload: { expected_frequency: 'hourly' },
    });
  });

  it('rejects an invalid source/event_name with 400', async () => {
    expect((await createRegistry({ source: 'pixel' })).statusCode).toBe(400);
    expect((await createRegistry({ source: 'app', event_name: 'Bad-Name' })).statusCode).toBe(400);
  });
});

describe('events overview (integration)', () => {
  it('grades every stream ok/stale/muted/unregistered per the contract', async () => {
    // el_checkout fired 3h ago; hourly cadence → stale.
    await createRegistry({ source: 'app', event_name: 'el_checkout', expected_frequency: 'hourly' });
    // conversion registered then muted.
    const conv = await createRegistry({ source: 'conversion', expected_frequency: 'daily' });
    await app.inject({
      method: 'PUT',
      url: `/marketing/events/registry/${conv.json().data.id}`,
      headers: auth(),
      payload: { is_active: false },
    });
    // Registered but never fired → appended at zero, stale under a cadence.
    await createRegistry({ source: 'app', event_name: 'el_ghost', expected_frequency: 'daily' });

    const res = await app.inject({ method: 'GET', url: `/marketing/events/overview?app=${APP}`, headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.app).toBe(APP);
    expect(body.period.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.period.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const streams = body.data.streams as Array<Record<string, unknown>>;

    const find = (source: string, eventName: string | null) =>
      streams.find((s) => s.source === source && s.event_name === eventName)!;

    // app / el_home_view: 1h old, hourly → ok.
    const home = find('app', 'el_home_view');
    expect(home).toMatchObject({ count_24h: 1, count_7d: 1, health: 'ok' });
    expect(home.last_seen).toMatch(/T.*Z$/);
    expect(home.registry).toMatchObject({ expected_frequency: 'hourly', is_active: true });

    // app / el_checkout: 3h old, hourly → stale.
    expect(find('app', 'el_checkout')).toMatchObject({ count_24h: 1, health: 'stale' });

    // app / el_ghost: registered, never fired → zero counts, stale.
    expect(find('app', 'el_ghost')).toMatchObject({ count_24h: 0, count_7d: 0, last_seen: null, health: 'stale' });

    // click: whole-stream row (event_name null), daily registered, 2h old → ok.
    const click = find('click', null);
    expect(click).toMatchObject({ count_24h: 1, count_7d: 1, health: 'ok' });
    expect(click.registry).toMatchObject({ expected_frequency: 'daily' });

    // conversion: registry muted → muted regardless of freshness.
    expect(find('conversion', null)).toMatchObject({ count_24h: 1, health: 'muted' });

    // touch + lead: data present, no registry row → unregistered.
    expect(find('touch', null)).toMatchObject({ count_24h: 1, health: 'unregistered', registry: null });
    expect(find('lead', null)).toMatchObject({ count_24h: 1, health: 'unregistered', registry: null });
  });
});

describe('events recent (integration)', () => {
  const recent = (qs: string) =>
    app.inject({ method: 'GET', url: `/marketing/events/recent?${qs}`, headers: auth() });

  it('returns app events newest-first, filterable by event_name', async () => {
    const res = await recent(`app=${APP}&source=app`);
    expect(res.statusCode).toBe(200);
    const events = res.json().data.events;
    expect(events.map((e: { event_name: string }) => e.event_name)).toEqual(['el_home_view', 'el_checkout']);
    expect(events[0]).toMatchObject({
      source: 'app',
      session_id: 's1',
      user_id: 1,
      platform: 'android',
      props: { screen: 'home' },
    });
    expect(events[0].occurred_at).toMatch(/T.*Z$/);

    const filtered = await recent(`app=${APP}&source=app&event_name=el_checkout&limit=5`);
    expect(filtered.json().data.events).toHaveLength(1);
    expect(filtered.json().data.events[0].event_name).toBe('el_checkout');
  });

  it('whitelists click props to {link_id, is_bot, device} — never ip_hash', async () => {
    const events = (await recent(`app=${APP}&source=click`)).json().data.events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: 'click',
      event_name: null,
      session_id: 'c1',
      props: { link_id: 5, is_bot: false, device: 'mobile' },
    });
    expect(Object.keys(events[0].props)).not.toContain('ip_hash');
  });

  it('shapes conversion, touch (presence booleans only) and lead rows', async () => {
    const conv = (await recent(`app=${APP}&source=conversion`)).json().data.events[0];
    expect(conv).toMatchObject({ source: 'conversion', user_id: 3, props: { order_id: 'O-1', value: 499.5 } });

    const touch = (await recent(`app=${APP}&source=touch`)).json().data.events[0];
    expect(touch.props).toEqual({
      utm_source: 'google',
      utm_campaign: 'diwali',
      channel: 'google',
      has_gclid: true,
      has_fbclid: false,
      has_ctwa_clid: false,
    });
    expect(JSON.stringify(touch)).not.toContain('g-secret-1'); // raw click id never leaks

    const lead = (await recent(`app=${APP}&source=lead`)).json().data.events[0];
    expect(lead).toMatchObject({
      source: 'lead',
      user_id: null,
      session_id: null,
      props: { lead_ref: 'L-1', capi_uploaded: false },
    });
  });

  it('validates source and limit bounds', async () => {
    expect((await recent(`app=${APP}&source=notification`)).statusCode).toBe(400);
    expect((await recent(`app=${APP}&source=app&limit=0`)).statusCode).toBe(400);
    expect((await recent(`app=${APP}&source=app&limit=201`)).statusCode).toBe(400);
  });
});
