import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { ConversionIngest, TouchIngest } from '../src/marketing/ingest/validators.js';

// Integration: real Postgres (pgvector) via Testcontainers. Sets DATABASE_URL
// BEFORE importing any module that reads config/env, then dynamic-imports.
let container: StartedPostgreSqlContainer;
let writeConversion: (p: ConversionIngest) => Promise<{ deduped: boolean }>;
let writeTouch: (p: TouchIngest) => Promise<void>;
let runResolver: (o?: { limit?: number }) => Promise<{ resolved: number; matched: number }>;
let queries: typeof import('../src/marketing/serving/queries.js');
let db: typeof import('../src/shared/db/index.js')['db'];
let schema: typeof import('../src/shared/schema/index.js');
let APP: string;

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

  ({ writeConversion } = await import('../src/marketing/ingest/conversion-writer.js'));
  ({ writeTouch } = await import('../src/marketing/ingest/touch-writer.js'));
  ({ runResolver } = await import('../src/marketing/attribution/resolve.js'));
  queries = await import('../src/marketing/serving/queries.js');
  ({ db } = await import('../src/shared/db/index.js'));
  schema = await import('../src/shared/schema/index.js');
  APP = (await import('../src/config/env.js')).env.MIL_DEFAULT_APP;
}, 120_000);

afterAll(async () => {
  const { pool } = await import('../src/shared/db/index.js');
  await pool.end();
  await container?.stop();
});

describe('attribution spine (integration)', () => {
  it('resolves last-touch to a campaign and computes the hero metric', async () => {
    await db.insert(schema.adEntity).values({
      app: APP,
      channel: 'meta',
      level: 'campaign',
      externalId: 'c1',
      name: 'mumbai_homecleaning_purchase',
      city: 'mumbai',
      category: 'homecleaning',
      objective: 'purchase',
      currency: 'INR',
    });
    const [ent] = await db.select({ id: schema.adEntity.id }).from(schema.adEntity);
    await db.insert(schema.adPerformanceDaily).values({
      app: APP,
      adEntityId: ent!.id,
      statDate: '2026-06-20',
      channel: 'meta',
      spendInr: '3000',
      impressions: 5000,
      clicks: 200,
      conversions: '10',
      convValueInr: '8000',
    });

    await writeTouch({
      app: APP,
      session_id: 's1',
      user_id: 42,
      occurred_at: '2026-06-20T09:00:00Z',
      utm_source: 'facebook',
      utm_campaign: 'mumbai_homecleaning_purchase',
      consent: true,
    } as TouchIngest);

    const conv: ConversionIngest = {
      app: APP,
      order_id: 'O1',
      user_id: 42,
      value_inr: 1500,
      is_first_order: true,
      action_source: 'app',
      occurred_at: '2026-06-20T10:00:00Z',
    } as ConversionIngest;

    expect((await writeConversion(conv)).deduped).toBe(false);
    expect((await writeConversion(conv)).deduped).toBe(true); // idempotent

    const res = await runResolver();
    expect(res.matched).toBe(1);

    const f = { app: APP, from: '2026-06-01', to: '2026-06-30' };
    const cac = await queries.cacSummary(f);
    expect(cac.first_orders).toBe(1);
    expect(cac.spend_inr).toBe(3000);
    expect(cac.blended_cac_inr).toBe(3000);

    const cpfo = await queries.costPerFirstOrder(f);
    const row = cpfo.find((r) => r.campaign === 'mumbai_homecleaning_purchase');
    expect(Number(row?.first_orders)).toBe(1);
    expect(Number(row?.cost_per_first_order_inr)).toBe(3000);
  });

  it('dry-run action port logs a proposed decision without mutating ads', async () => {
    const { actionPort } = await import('../src/marketing/actions/index.js');
    expect(actionPort.mode).toBe('dry_run');
    const res = await actionPort.setDailyBudgetInr(
      { app: APP, channel: 'meta', level: 'campaign', externalId: 'c1' },
      250,
      { source: 'rules', reason: 'CAC above threshold', correlationId: 'corr-1' },
    );
    expect(res).toMatchObject({ ok: true, mode: 'dry_run', status: 'proposed' });

    const [row] = await db
      .select()
      .from(schema.decision)
      .where(eq(schema.decision.id, res.decisionId!));
    expect(row).toMatchObject({
      mode: 'dry_run',
      status: 'proposed',
      actionType: 'set_budget',
      source: 'rules',
    });
    expect(row?.actionParams).toEqual({ amountInr: 250 });
  });
});
