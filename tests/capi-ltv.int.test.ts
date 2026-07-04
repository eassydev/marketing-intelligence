import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Integration: real Postgres (pgvector) via Testcontainers. Sets DATABASE_URL
// AND the CAPI env (enabled) BEFORE importing any module that reads config/env,
// then dynamic-imports. Covers the LTV:CAC queries and the CAPI upload job's
// select→send→mark loop with a stubbed Meta endpoint.
let container: StartedPostgreSqlContainer;
let queries: typeof import('../src/marketing/serving/queries.js');
let db: typeof import('../src/shared/db/index.js')['db'];
let schema: typeof import('../src/shared/schema/index.js');
let runCapiUpload: typeof import('../src/marketing/capi/upload-job.js')['runCapiUpload'];

const F = { app: 'services' as const, from: '2026-06-01', to: '2026-06-30' };

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.META_CAPI_ENABLED = 'true';
  process.env.META_ACCESS_TOKEN = 'test-capi-token';
  process.env.META_CAPI_DATASET_ID = '1717873222070120';

  const dir = join(process.cwd(), 'drizzle');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await client.query(readFileSync(join(dir, f), 'utf8'));
  }
  client.release();
  await pool.end();

  queries = await import('../src/marketing/serving/queries.js');
  ({ db } = await import('../src/shared/db/index.js'));
  schema = await import('../src/shared/schema/index.js');
  ({ runCapiUpload } = await import('../src/marketing/capi/upload-job.js'));

  // Seed: one meta campaign, a repeat customer (user 1) + a one-time customer
  // (user 2), and ₹1000 spend on meta in the window.
  await db.insert(schema.adEntity).values({
    app: 'services',
    channel: 'meta',
    level: 'campaign',
    externalId: 'c1',
    name: 'bangalore_homecleaning_purchase',
    city: 'bangalore',
    category: 'homecleaning',
    objective: 'purchase',
    currency: 'INR',
  });
  const [ent] = await db.select({ id: schema.adEntity.id }).from(schema.adEntity);

  await db.insert(schema.adPerformanceDaily).values({
    app: 'services',
    adEntityId: ent!.id,
    statDate: '2026-06-05',
    channel: 'meta',
    spendInr: '1000.00',
  });

  await db.insert(schema.attributionTouch).values({
    app: 'services',
    occurredAt: new Date('2026-06-05T09:00:00Z'),
    channel: 'meta',
    sessionId: 's1',
    userId: 1,
    fbc: 'fb.1.1.abc',
    fbp: 'fb.1.1.xyz',
  });

  const conv = (
    orderId: string,
    userId: number,
    date: string,
    value: string,
    isFirst: boolean,
    sessionId: string | null,
  ) => ({
    app: 'services' as const,
    orderId,
    userId,
    occurredAt: new Date(`${date}T10:00:00Z`),
    valueInr: value,
    isFirstOrder: isFirst,
    city: 'bangalore',
    category: 'homecleaning',
    actionSource: 'website',
    sessionId,
    attributedChannel: isFirst ? 'meta' : null,
    attributedEntityId: isFirst ? ent!.id : null,
    attributionOutcome: 'matched',
    resolvedAt: new Date(`${date}T10:05:00Z`),
  });

  await db.insert(schema.conversion).values([
    conv('O1', 1, '2026-06-05', '1000.00', true, 's1'), // user 1 acquisition
    conv('O2', 1, '2026-06-15', '500.00', false, 's1'), // user 1 repeat
    conv('O3', 2, '2026-06-10', '2000.00', true, null), // user 2 acquisition
  ]);
}, 120_000);

afterAll(async () => {
  const { pool } = await import('../src/shared/db/index.js');
  await pool.end();
  await container?.stop();
});

describe('LTV:CAC queries (integration)', () => {
  it('repeatRate: 1 of 2 customers repeats', async () => {
    const r = await queries.repeatRate(F);
    expect(r.customers).toBe(2);
    expect(r.repeat_customers).toBe(1);
    expect(r.repeat_rate).toBe(0.5);
    expect(r.avg_orders_per_customer).toBe(1.5);
    expect(r.avg_revenue_per_customer_inr).toBe(1750);
  });

  it('cohortRevenue: cumulative revenue for the meta cohort', async () => {
    const rows = await queries.cohortRevenue(F);
    const meta = rows.find((x) => x.channel === 'meta');
    expect(meta).toBeTruthy();
    expect(Number(meta!.customers)).toBe(2);
    expect(Number(meta!.cumulative_revenue_inr)).toBe(3500); // 1000+500+2000
    expect(Number(meta!.ltv_per_customer_inr)).toBe(1750);
  });

  it('ltvCac: ratio = cohort revenue ÷ channel spend', async () => {
    const rows = await queries.ltvCac(F);
    const meta = rows.find((x) => x.channel === 'meta');
    expect(meta).toBeTruthy();
    expect(meta!.spend_inr).toBe(1000);
    expect(meta!.acquired_customers).toBe(2);
    expect(meta!.cohort_revenue_inr).toBe(3500);
    expect(meta!.cac_inr).toBe(500); // 1000 / 2
    expect(meta!.ltv_cac_ratio).toBe(3.5); // 3500 / 1000
  });
});

describe('CAPI upload job (integration)', () => {
  it('sends pending resolved purchases and marks capi_uploaded_at on success', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: { body: string }) => ({
      ok: true,
      status: 200,
      json: async () => ({ events_received: 3 }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runCapiUpload();
    vi.unstubAllGlobals();

    expect(result.apps).toEqual([{ app: 'services', selected: 3, uploaded: 3 }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The batch body carries one event per order, keyed on order_id for dedup.
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body);
    const ids = body.data.map((e: { event_id: string }) => e.event_id).sort();
    expect(ids).toEqual(['O1', 'O2', 'O3']);
    const o1 = body.data.find((e: { event_id: string }) => e.event_id === 'O1');
    expect(o1.event_name).toBe('Purchase');
    expect(Array.isArray(o1.user_data.external_id)).toBe(true); // hashed
    expect(o1.user_data.fbc).toBe('fb.1.1.abc'); // raw, from attribution_touch

    // All three rows are now marked uploaded → a second run finds nothing.
    const second = await runCapiUpload();
    expect(second.apps).toEqual([{ app: 'services', selected: 0, uploaded: 0 }]);
  });
});
