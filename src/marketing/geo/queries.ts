import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../shared/db/index.js';
import type { AppKind } from '../../shared/types/app.js';

export interface GeoFilters {
  app: AppKind;
  from: string; // YYYY-MM-DD inclusive
  to: string; // YYYY-MM-DD inclusive
}

export interface MentionRateRow {
  dimension: string;
  observations: number;
  mentions: number;
  mention_rate: number | null;
}

export interface GeoTotals {
  observations: number;
  mentions: number;
  mention_rate: number | null;
}

export interface LatestRun {
  run_at: string;
  observations: number;
  mentions: number;
}

function windowClause(f: GeoFilters): SQL {
  return sql`g.app = ${f.app} and g.run_at::date between ${f.from} and ${f.to}`;
}

const RATE = sql`
  count(*)::float8 as observations,
  count(*) filter (where g.brand_mentioned)::float8 as mentions,
  case when count(*) > 0
    then round((count(*) filter (where g.brand_mentioned))::numeric / count(*), 4)::float8
    else null end as mention_rate`;

export async function geoTotals(f: GeoFilters): Promise<GeoTotals> {
  const res = await db.execute(sql`
    select ${RATE} from marketing.geo_observation g where ${windowClause(f)}`);
  return res.rows[0] as unknown as GeoTotals;
}

export async function mentionRateByEngine(f: GeoFilters): Promise<MentionRateRow[]> {
  const res = await db.execute(sql`
    select g.engine as dimension, ${RATE}
    from marketing.geo_observation g
    where ${windowClause(f)}
    group by g.engine
    order by g.engine`);
  return res.rows as unknown as MentionRateRow[];
}

/**
 * City/category live inside prompt_key (`{template}|{category}|{city}` — see
 * questions.ts); split them back out here. Brand probes (`brand|…`) carry
 * neither, so they are excluded from these two breakdowns.
 */
function mentionRateByKeyPart(f: GeoFilters, part: 2 | 3): Promise<MentionRateRow[]> {
  return db
    .execute(
      sql`
    select split_part(g.prompt_key, '|', ${part}) as dimension, ${RATE}
    from marketing.geo_observation g
    where ${windowClause(f)} and split_part(g.prompt_key, '|', 1) <> 'brand'
    group by dimension
    order by dimension`,
    )
    .then((res) => res.rows as unknown as MentionRateRow[]);
}

export const mentionRateByCategory = (f: GeoFilters): Promise<MentionRateRow[]> =>
  mentionRateByKeyPart(f, 2);

export const mentionRateByCity = (f: GeoFilters): Promise<MentionRateRow[]> =>
  mentionRateByKeyPart(f, 3);

/** Totals for the most recent run (all rows share the run's run_at). */
export async function latestRun(app: AppKind): Promise<LatestRun | null> {
  const res = await db.execute(sql`
    select g.run_at, ${RATE}
    from marketing.geo_observation g
    where g.app = ${app}
      and g.run_at = (select max(run_at) from marketing.geo_observation where app = ${app})
    group by g.run_at`);
  return (res.rows[0] as unknown as LatestRun | undefined) ?? null;
}
