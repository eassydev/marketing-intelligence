import { sql } from 'drizzle-orm';
import { db } from '../../shared/db/index.js';
import { env } from '../../config/env.js';
import { createChildLogger } from '../../shared/logger/index.js';
import {
  applyMetaInstallReferrer,
  decryptMetaInstallReferrer,
  type MetaReferrerResult,
} from '../attribution/meta-install-referrer.js';
import type { TouchIngest } from '../ingest/validators.js';

const log = createChildLogger({ module: 'meta-referrer-backfill' });

const PAGE_SIZE = 200;

export interface MetaReferrerBackfillStats {
  apply: boolean;
  scanned: number;
  byStatus: Partial<Record<MetaReferrerResult['status'], number>>;
  updated: number;
  propagated: number;
  byCampaign: Record<string, number>;
}

interface CandidateRow {
  id: string | number;
  app: string;
  session_id: string | null;
  touch_type: string;
  consent: boolean;
  channel: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  referrer: string | null;
}

function toTouch(row: CandidateRow): TouchIngest {
  return {
    app: row.app as TouchIngest['app'],
    session_id: row.session_id ?? '',
    touch_type: row.touch_type as TouchIngest['touch_type'],
    consent: row.consent,
    channel: row.channel as TouchIngest['channel'],
    utm_source: row.utm_source,
    utm_medium: row.utm_medium,
    utm_campaign: row.utm_campaign,
    utm_content: row.utm_content,
    utm_term: row.utm_term,
    referrer: row.referrer,
  };
}

async function decryptStoredRows(stats: MetaReferrerBackfillStats, key: string): Promise<void> {
  let lastId = '0';
  for (;;) {
    const page = await db.execute(sql`
      select id, app, session_id, touch_type, consent, channel, utm_source, utm_medium,
             utm_campaign, utm_content, utm_term, referrer
        from marketing.attribution_touch
       where id > ${lastId}::bigint
         and (referrer ilike '%22source%22%' or referrer like '%"source"%' or utm_content like '%"source"%')
         and raw -> 'meta_install_referrer' is null
       order by id
       limit ${PAGE_SIZE}`);
    const rows = page.rows as unknown as CandidateRow[];
    if (rows.length === 0) return;
    lastId = String(rows[rows.length - 1]!.id);

    for (const row of rows) {
      stats.scanned += 1;
      const result = decryptMetaInstallReferrer(row, key);
      stats.byStatus[result.status] = (stats.byStatus[result.status] ?? 0) + 1;
      if (result.status !== 'ok') continue;
      const campaignKey = result.ids.campaignKey;
      stats.byCampaign[campaignKey] = (stats.byCampaign[campaignKey] ?? 0) + 1;
      if (!stats.apply) continue;

      const fixed = applyMetaInstallReferrer(toTouch(row), result);
      const metaRaw = (fixed.raw as Record<string, unknown>).meta_install_referrer;
      // Merge into the CURRENT raw (not a snapshot) and re-check the marker so
      // a concurrent ingest-time rewrite is never clobbered.
      const res = await db.execute(sql`
        update marketing.attribution_touch
           set utm_campaign = ${fixed.utm_campaign ?? null},
               utm_term = ${fixed.utm_term ?? null},
               utm_content = ${fixed.utm_content ?? null},
               channel = coalesce(channel, ${fixed.channel ?? null}),
               raw = coalesce(raw, '{}'::jsonb)
                     || jsonb_build_object('meta_install_referrer', ${JSON.stringify(metaRaw)}::jsonb)
         where id = ${String(row.id)}::bigint
           and raw -> 'meta_install_referrer' is null`);
      stats.updated += res.rowCount ?? 0;
    }
  }
}

/**
 * Set-based propagation: every generic fb4a/ig4a touch whose session has a
 * decrypted envelope takes that session's ids (same install, same device).
 * Idempotent; also repairs any ingest-time propagation that failed.
 */
async function propagateAllSessions(stats: MetaReferrerBackfillStats): Promise<void> {
  const source = sql`
    select distinct on (app, session_id) app, session_id, utm_campaign, utm_term, utm_content
      from marketing.attribution_touch
     where session_id is not null
       and raw -> 'meta_install_referrer' ->> 'nonce' is not null
     order by app, session_id, id`;
  const target = sql`
    t.app = src.app and t.session_id = src.session_id
    and lower(t.utm_campaign) in ('fb4a', 'ig4a')
    and t.raw -> 'meta_install_referrer' is null`;

  if (!stats.apply) {
    const res = await db.execute(sql`
      with src as (${source})
      select count(*)::int as n from marketing.attribution_touch t join src on ${target}`);
    stats.propagated = Number((res.rows[0] as { n: number }).n);
    return;
  }
  const res = await db.execute(sql`
    with src as (${source})
    update marketing.attribution_touch t
       set utm_campaign = src.utm_campaign,
           utm_term = coalesce(src.utm_term, t.utm_term),
           utm_content = coalesce(src.utm_content, t.utm_content),
           channel = coalesce(t.channel, 'meta'),
           raw = coalesce(t.raw, '{}'::jsonb) || jsonb_build_object(
             'meta_install_referrer', jsonb_build_object(
               'propagated', true,
               'original', jsonb_build_object(
                 'utm_source', t.utm_source, 'utm_campaign', t.utm_campaign,
                 'utm_term', t.utm_term, 'utm_content', t.utm_content)))
      from src
     where ${target}`);
  stats.propagated = res.rowCount ?? 0;
}

/**
 * One-off repair: decrypt Meta install referrers already stored in
 * attribution_touch (they reached MIL through BackendNew's registration forward
 * before decryption existed), then correct same-session fb4a/ig4a touches.
 * Dry run unless `apply` is true — the dry run writes nothing and reports what
 * would change, per status and per campaign. Idempotent.
 */
export async function runMetaReferrerBackfill(
  opts: { apply?: boolean } = {},
): Promise<MetaReferrerBackfillStats> {
  const key = env.META_INSTALL_REFERRER_KEY;
  if (!key) throw new Error('META_INSTALL_REFERRER_KEY is not set');

  const stats: MetaReferrerBackfillStats = {
    apply: opts.apply === true,
    scanned: 0,
    byStatus: {},
    updated: 0,
    propagated: 0,
    byCampaign: {},
  };
  await decryptStoredRows(stats, key);
  await propagateAllSessions(stats);

  log.info(stats, stats.apply ? 'meta referrer backfill applied' : 'meta referrer backfill dry run');
  return stats;
}
