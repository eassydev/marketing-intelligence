import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Integration: real Postgres (pgvector) via Testcontainers. Sets DATABASE_URL
// BEFORE importing any module that reads config/env, then dynamic-imports.
// Covers the Phase 6 campaign-attributed funnel end to end: touches (incl.
// touch_type='first_party_click'), app_event stages, identity_link stitching,
// conversions and ad spend — plus the offline-campaign NULL-impressions case.
let container: StartedPostgreSqlContainer;
let campaignFunnel: typeof import('../src/marketing/serving/campaign-funnel-queries.js')['campaignFunnel'];
let db: typeof import('../src/shared/db/index.js')['db'];
let schema: typeof import('../src/shared/schema/index.js');
let APP: string;

const F = { from: '2026-06-01', to: '2026-06-30' };
const ADS_CAMPAIGN = 'mumbai_deepclean_purchase';
const OFFLINE_CAMPAIGN = 'blr_society_qr';

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

  ({ campaignFunnel } = await import('../src/marketing/serving/campaign-funnel-queries.js'));
  ({ db } = await import('../src/shared/db/index.js'));
  schema = await import('../src/shared/schema/index.js');
  APP = (await import('../src/config/env.js')).env.MIL_DEFAULT_APP;

  // ── Ads campaign: ad entity + spend ──────────────────────────────────────
  await db.insert(schema.adEntity).values({
    app: APP,
    channel: 'meta',
    level: 'campaign',
    externalId: 'cf-c1',
    name: ADS_CAMPAIGN,
    city: 'mumbai',
    category: 'deepclean',
    objective: 'purchase',
    currency: 'INR',
  });
  const [ent] = await db.select({ id: schema.adEntity.id }).from(schema.adEntity);
  await db.insert(schema.adPerformanceDaily).values({
    app: APP,
    adEntityId: ent!.id,
    statDate: '2026-06-10',
    channel: 'meta',
    spendInr: '5000.00',
    impressions: 10_000,
    clicks: 400,
  });

  // ── Touches: two first-party clicks on the ads campaign (sessions fs1/fs2,
  //    anonymous at click time), one on the offline campaign (fs3). ──────────
  const touch = (
    sessionId: string,
    utmCampaign: string,
    occurredAt: string,
    channel: string | null,
  ) => ({
    app: APP,
    occurredAt: new Date(occurredAt),
    channel,
    touchType: 'first_party_click',
    sessionId,
    utmCampaign,
    utmMedium: 'qr',
    consent: true,
  });
  await db.insert(schema.attributionTouch).values([
    touch('fs1', ADS_CAMPAIGN, '2026-06-10T08:00:00Z', 'meta'),
    touch('fs2', ADS_CAMPAIGN, '2026-06-11T08:00:00Z', 'meta'),
    touch('fs3', OFFLINE_CAMPAIGN, '2026-06-15T08:00:00Z', null),
  ]);

  // fs1 later revealed identity (user 501) — the stitch the conversion rides.
  await db.insert(schema.identityLink).values({ app: APP, sessionId: 'fs1', userId: 501 });

  // ── App events: fs1 completes install→signup→add_to_cart; fs2 installs only;
  //    fs5 installs with NO campaign touch (organic — must not be attributed).
  const ev = (sessionId: string, eventName: string, occurredAt: string) => ({
    eventId: randomUUID(),
    app: APP,
    eventName,
    occurredAt: new Date(occurredAt),
    sessionId,
  });
  await db.insert(schema.appEvent).values([
    ev('fs1', 'el_first_open', '2026-06-10T09:00:00Z'),
    ev('fs1', 'el_signup', '2026-06-10T10:00:00Z'),
    ev('fs1', 'el_add_to_cart', '2026-06-10T11:00:00Z'),
    ev('fs2', 'el_first_open', '2026-06-11T09:00:00Z'),
    ev('fs5', 'el_first_open', '2026-06-12T09:00:00Z'),
  ]);

  // ── Conversion by user 501 (identity-stitched to fs1's touch). ────────────
  await db.insert(schema.conversion).values({
    app: APP,
    orderId: 'CF-O1',
    userId: 501,
    occurredAt: new Date('2026-06-12T10:00:00Z'),
    valueInr: '1200.00',
    isFirstOrder: true,
    actionSource: 'app',
  });
}, 120_000);

afterAll(async () => {
  const { pool } = await import('../src/shared/db/index.js');
  await pool.end();
  await container?.stop();
});

describe('campaignFunnel (integration)', () => {
  it('computes every stage for an ads-backed campaign', async () => {
    const rows = await campaignFunnel({ app: APP, ...F });
    const ads = rows.find((r) => r.utm_campaign === ADS_CAMPAIGN);
    expect(ads).toBeTruthy();
    expect(ads!.impressions).toBe(10_000);
    expect(ads!.ad_clicks).toBe(400);
    expect(ads!.ad_spend_inr).toBe(5000);
    expect(ads!.first_party_clicks).toBe(2);
    expect(ads!.installs).toBe(2); // fs1 + fs2; organic fs5 excluded
    expect(ads!.registrations).toBe(1); // fs1 only
    expect(ads!.add_to_cart).toBe(1);
    expect(ads!.orders).toBe(1); // user 501 via fs1 identity_link
    expect(ads!.revenue_inr).toBe(1200);
  });

  it('reports NULL impressions/clicks/spend for an offline campaign', async () => {
    const rows = await campaignFunnel({ app: APP, ...F });
    const offline = rows.find((r) => r.utm_campaign === OFFLINE_CAMPAIGN);
    expect(offline).toBeTruthy();
    expect(offline!.impressions).toBeNull();
    expect(offline!.ad_clicks).toBeNull();
    expect(offline!.ad_spend_inr).toBeNull();
    expect(offline!.first_party_clicks).toBe(1);
    expect(offline!.installs).toBe(0);
    expect(offline!.orders).toBe(0);
    expect(offline!.revenue_inr).toBe(0);
  });

  it('narrows to a single campaign with utm_campaign (case-insensitive)', async () => {
    const rows = await campaignFunnel({
      app: APP,
      ...F,
      utmCampaign: ADS_CAMPAIGN.toUpperCase(),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.utm_campaign).toBe(ADS_CAMPAIGN);
  });

  it('channel filter keeps only that channel’s touch campaigns', async () => {
    const rows = await campaignFunnel({ app: APP, ...F, channel: 'meta' });
    expect(rows.map((r) => r.utm_campaign)).toEqual([ADS_CAMPAIGN]);
  });

  it('medium filter drops ad-only campaigns and keeps touch-bearing ones', async () => {
    const rows = await campaignFunnel({ app: APP, ...F, medium: 'qr' });
    expect(rows.map((r) => r.utm_campaign).sort()).toEqual(
      [ADS_CAMPAIGN, OFFLINE_CAMPAIGN].sort(),
    );
    expect(rows.find((r) => r.utm_campaign === ADS_CAMPAIGN)!.ad_spend_inr).toBe(5000);
  });
});
