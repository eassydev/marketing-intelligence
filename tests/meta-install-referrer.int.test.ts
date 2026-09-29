import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

// Integration: Meta install-referrer decryption end to end against real
// Postgres — ingest rewrite, same-session propagation (both orders), installs
// counted from authenticated referrers (no login, one per nonce, no lookback),
// and the backfill job. Every case owns its campaign, so order doesn't matter.
// The key must be in the environment BEFORE config/env is imported.
const KEY = randomBytes(32).toString('hex');
process.env.META_INSTALL_REFERRER_KEY = KEY;

const F = { from: '2026-06-01', to: '2026-06-30' };

interface Campaign {
  name: string;
  campaignId: string;
  adsetId: string;
  adId: string;
}
const campaign = (n: number): Campaign => ({
  name: `el_int_campaign_${n}`,
  campaignId: `10010${n}`,
  adsetId: `20020${n}`,
  adId: `30030${n}`,
});
const C = {
  unregistered: campaign(1),
  registered: campaign(2),
  reverse: campaign(3),
  longGap: campaign(4),
  replay: campaign(5),
  backfill: campaign(6),
};

let container: StartedPostgreSqlContainer;
let writeTouch: typeof import('../src/marketing/ingest/touch-writer.js')['writeTouch'];
let campaignFunnel: typeof import('../src/marketing/serving/campaign-funnel-queries.js')['campaignFunnel'];
let runBackfill: typeof import('../src/marketing/jobs/meta-referrer-backfill.js')['runMetaReferrerBackfill'];
let db: typeof import('../src/shared/db/index.js')['db'];
let schema: typeof import('../src/shared/schema/index.js');
let APP: 'services';

/** Meta's Play referrer for a click on `c`, encrypted with `keyHex`. */
function metaReferrer(
  label: 'fb4a' | 'ig4a',
  c: Campaign,
  opts: { keyHex?: string; clickTs?: number } = {},
): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(opts.keyHex ?? KEY, 'hex'), nonce);
  // Bare JSON numbers for the ids, as the real payload may send them.
  const plaintext = `{"campaign_group_id":${c.campaignId},"campaign_id":${c.adsetId},"adgroup_id":${c.adId},"campaign_group_name":"${c.name}"}`;
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const source = { data: Buffer.concat([body, cipher.getAuthTag()]).toString('hex'), nonce: nonce.toString('hex') };
  const clickTs = opts.clickTs ?? Date.parse('2026-06-10T09:50:00Z') / 1000;
  const utmContent = JSON.stringify({ app: 1717873222070120, t: clickTs, source });
  const host = label === 'fb4a' ? 'apps.facebook.com' : 'apps.instagram.com';
  return `utm_source=${host}&utm_campaign=${label}&utm_content=${encodeURIComponent(utmContent)}`;
}

async function touchesFor(sessionId: string) {
  const res = await db.execute(sql`
    select utm_campaign, utm_term, utm_content, channel, user_id, raw
      from marketing.attribution_touch where session_id = ${sessionId} order by id`);
  return res.rows as Array<Record<string, any>>;
}

async function funnelRow(c: Campaign) {
  return (await campaignFunnel({ app: APP, ...F })).find((r) => r.utm_campaign === c.name);
}

const installTouch = (sessionId: string, referrer: string | undefined, occurredAt: string) => ({
  app: APP,
  session_id: sessionId,
  touch_type: 'touch' as const,
  consent: true,
  occurred_at: occurredAt,
  utm_source: 'apps.facebook.com',
  utm_campaign: 'fb4a',
  ...(referrer ? { referrer } : {}),
});

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

  ({ writeTouch } = await import('../src/marketing/ingest/touch-writer.js'));
  ({ campaignFunnel } = await import('../src/marketing/serving/campaign-funnel-queries.js'));
  ({ runMetaReferrerBackfill: runBackfill } = await import('../src/marketing/jobs/meta-referrer-backfill.js'));
  ({ db } = await import('../src/shared/db/index.js'));
  schema = await import('../src/shared/schema/index.js');
  APP = (await import('../src/config/env.js')).env.MIL_DEFAULT_APP as 'services';

  // Campaign → ad set → ad per case, spend on the ad (as Meta ingest does), so
  // every campaign is in the funnel universe regardless of touches.
  for (const c of Object.values(C)) {
    const entity = (level: string, externalId: string, name: string, parent: string | null) => ({
      app: APP,
      channel: 'meta',
      level,
      externalId,
      name,
      parentExternalId: parent,
      currency: 'INR',
    });
    await db.insert(schema.adEntity).values([
      entity('campaign', c.campaignId, c.name, null),
      entity('adset', c.adsetId, `${c.name} adset`, c.campaignId),
      entity('ad', c.adId, `${c.name} ad`, c.adsetId),
    ]);
    const ad = await db.execute(sql`select id from marketing.ad_entity where external_id = ${c.adId}`);
    await db.insert(schema.adPerformanceDaily).values({
      app: APP,
      adEntityId: Number((ad.rows[0] as { id: number }).id),
      statDate: '2026-06-10',
      channel: 'meta',
      spendInr: '1000.00',
      impressions: 5000,
      clicks: 200,
    });
  }
}, 120_000);

afterAll(async () => {
  const { pool } = await import('../src/shared/db/index.js');
  await pool.end();
  await container?.stop();
});

describe('Meta install referrer (integration)', () => {
  it('decrypts at ingest and counts the install with no login', async () => {
    const c = C.unregistered;
    await writeTouch(installTouch('mir-unreg', metaReferrer('fb4a', c), '2026-06-10T09:50:00Z'));

    const [row] = await touchesFor('mir-unreg');
    expect(row!.utm_campaign).toBe(c.campaignId);
    expect(row!.utm_term).toBe(c.adsetId);
    expect(row!.utm_content).toBe(c.adId);
    expect(row!.channel).toBe('meta');
    expect(row!.raw.meta_install_referrer.nonce).toMatch(/^[0-9a-f]{24}$/);
    expect(row!.raw.meta_install_referrer.original.utm_campaign).toBe('fb4a');

    const paid = await funnelRow(c);
    expect(paid?.ad_spend_inr).toBe(1000);
    expect(paid?.installs).toBe(1);
  });

  it('registration forward corrects the earlier install touch; one install per user', async () => {
    const c = C.registered;
    // Pre-fix install touch: the Worker had dropped the referrer, so fb4a only.
    await writeTouch(installTouch('mir-reg', undefined, '2026-06-11T08:55:00Z'));
    // Unrelated session and a non-generic sibling must stay untouched.
    await writeTouch(installTouch('mir-reg-other', undefined, '2026-06-11T08:56:00Z'));
    await writeTouch({ ...installTouch('mir-reg', undefined, '2026-06-11T08:57:00Z'), utm_campaign: 'summer_qr' });
    await writeTouch({
      ...installTouch('mir-reg', metaReferrer('fb4a', c, { clickTs: Date.parse('2026-06-11T08:50:00Z') / 1000 }), '2026-06-11T12:00:00Z'),
      user_id: 9001,
      consent: false,
    });
    await db.insert(schema.appEvent).values([
      { app: APP, eventId: randomUUID(), eventName: 'el_first_open', occurredAt: new Date('2026-06-11T09:01:00Z'), sessionId: 'mir-reg', userId: 9001 },
      { app: APP, eventId: randomUUID(), eventName: 'el_signup', occurredAt: new Date('2026-06-11T12:00:01Z'), sessionId: 'mir-reg', userId: 9001 },
    ]);

    const rows = await touchesFor('mir-reg');
    expect(rows.map((r) => r.utm_campaign)).toEqual([c.campaignId, 'summer_qr', c.campaignId]);
    expect(rows[0]!.raw.meta_install_referrer.propagated).toBe(true);
    expect(rows.every((r) => r.user_id === '9001')).toBe(true);
    expect((await touchesFor('mir-reg-other'))[0]!.utm_campaign).toBe('fb4a');

    const paid = await funnelRow(c);
    expect(paid?.installs).toBe(1); // referrer install + el_first_open of one user
    expect(paid?.registrations).toBe(1);
  });

  it('a generic touch arriving after the decrypted one takes its ids', async () => {
    const c = C.reverse;
    await writeTouch({
      ...installTouch('mir-rev', metaReferrer('ig4a', c), '2026-06-12T12:00:00Z'),
      utm_campaign: 'ig4a',
      user_id: 9003,
      consent: false,
    });
    await writeTouch({ ...installTouch('mir-rev', undefined, '2026-06-12T12:05:00Z'), utm_campaign: 'ig4a' });
    const rows = await touchesFor('mir-rev');
    expect(rows.map((r) => r.utm_campaign)).toEqual([c.campaignId, c.campaignId]);
    expect(rows[1]!.raw.meta_install_referrer.propagated).toBe(true);
  });

  it('install is timed at the click and credited directly — no lookback cut-off', async () => {
    const c = C.longGap;
    // Click on 5 Jun, registration forward (the only envelope copy) on 20 Jun:
    // 15 days apart, well past the 7-day lookback.
    await writeTouch({
      ...installTouch('mir-gap', metaReferrer('fb4a', c, { clickTs: Date.parse('2026-06-05T10:00:00Z') / 1000 }), '2026-06-20T10:00:00Z'),
      user_id: 9004,
      consent: false,
    });
    expect((await funnelRow(c))?.installs).toBe(1);
    const afterClick = (await campaignFunnel({ app: APP, from: '2026-06-06', to: '2026-06-30' })).find(
      (r) => r.utm_campaign === c.name,
    );
    expect(afterClick?.installs ?? 0).toBe(0); // the install belongs to 5 Jun
  });

  it('a replayed envelope counts once, however many sessions post it', async () => {
    const c = C.replay;
    const referrer = metaReferrer('ig4a', c);
    for (const sid of ['mir-replay-1', 'mir-replay-2', 'mir-replay-3']) {
      await writeTouch({ ...installTouch(sid, referrer, '2026-06-10T09:50:00Z'), utm_campaign: 'ig4a' });
    }
    expect((await funnelRow(c))?.installs).toBe(1);
  });

  it('leaves an undecryptable referrer on its generic label', async () => {
    await writeTouch(
      installTouch('mir-wrong-key', metaReferrer('fb4a', C.unregistered, { keyHex: randomBytes(32).toString('hex') }), '2026-06-12T08:55:00Z'),
    );
    const [row] = await touchesFor('mir-wrong-key');
    expect(row!.utm_campaign).toBe('fb4a');
    expect(row!.raw).toBeNull();
  });

  it('backfill: dry run changes nothing, apply fixes stored rows + session, re-run is a no-op', async () => {
    const c = C.backfill;
    // Rows stored before decryption existed (inserted directly, bypassing the writer).
    await db.insert(schema.attributionTouch).values([
      {
        app: APP,
        occurredAt: new Date('2026-06-13T08:55:00Z'),
        touchType: 'touch',
        sessionId: 'mir-backfill',
        utmSource: 'apps.facebook.com',
        utmCampaign: 'fb4a',
        consent: true,
      },
      {
        app: APP,
        occurredAt: new Date('2026-06-13T12:00:00Z'),
        touchType: 'touch',
        sessionId: 'mir-backfill',
        userId: 9002,
        utmSource: 'apps.facebook.com',
        utmCampaign: 'fb4a',
        referrer: metaReferrer('fb4a', c),
        consent: false,
      },
    ]);

    const dry = await runBackfill();
    expect(dry.apply).toBe(false);
    expect(dry.byCampaign[c.campaignId]).toBe(1);
    expect(dry.byStatus.decrypt_failed).toBeGreaterThanOrEqual(1); // the wrong-key row
    expect(dry.propagated).toBe(0); // the decrypted row isn't written in a dry run
    expect((await touchesFor('mir-backfill')).every((r) => r.utm_campaign === 'fb4a')).toBe(true);

    const applied = await runBackfill({ apply: true });
    expect(applied.updated).toBe(1);
    expect(applied.propagated).toBe(1);
    expect((await touchesFor('mir-backfill')).every((r) => r.utm_campaign === c.campaignId)).toBe(true);
    expect((await funnelRow(c))?.installs).toBe(1);

    const again = await runBackfill({ apply: true });
    expect(again.byCampaign).toEqual({});
    expect(again.updated).toBe(0);
    expect(again.propagated).toBe(0);
  });
});
