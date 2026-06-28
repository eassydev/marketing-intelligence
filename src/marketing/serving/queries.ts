import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../shared/db/index.js';
import type { AppKind } from '../../shared/types/app.js';

export interface SpendFilters {
  app: AppKind;
  from: string;
  to: string;
  city?: string;
  category?: string;
}

export interface SpendSummary {
  spend_inr: number;
  impressions: number;
  clicks: number;
  platform_conversions: number;
  conv_value_inr: number;
}

function filterClause(f: SpendFilters): SQL {
  const parts: SQL[] = [
    sql`p.app = ${f.app}`,
    sql`p.stat_date between ${f.from} and ${f.to}`,
  ];
  if (f.city) parts.push(sql`e.city = ${f.city}`);
  if (f.category) parts.push(sql`e.category = ${f.category}`);
  return sql.join(parts, sql` and `);
}

const SUMS = sql`
  coalesce(sum(p.spend_inr), 0)::float8       as spend_inr,
  coalesce(sum(p.impressions), 0)::float8     as impressions,
  coalesce(sum(p.clicks), 0)::float8          as clicks,
  coalesce(sum(p.conversions), 0)::float8     as platform_conversions,
  coalesce(sum(p.conv_value_inr), 0)::float8  as conv_value_inr`;

export async function spendSummary(f: SpendFilters): Promise<SpendSummary> {
  const res = await db.execute(sql`
    select ${SUMS}
    from marketing.ad_performance_daily p
    join marketing.ad_entity e on e.id = p.ad_entity_id
    where ${filterClause(f)}`);
  return (res.rows[0] as unknown as SpendSummary) ?? {
    spend_inr: 0,
    impressions: 0,
    clicks: 0,
    platform_conversions: 0,
    conv_value_inr: 0,
  };
}

export type Dimension = 'city' | 'category' | 'campaign';

const DIM_COLUMN: Record<Dimension, SQL> = {
  city: sql`e.city`,
  category: sql`e.category`,
  campaign: sql`e.name`,
};

export async function spendBreakdown(
  f: SpendFilters,
  dimension: Dimension,
): Promise<Array<Record<string, unknown>>> {
  const col = DIM_COLUMN[dimension];
  const res = await db.execute(sql`
    select ${col} as ${sql.raw(dimension)}, ${SUMS}
    from marketing.ad_performance_daily p
    join marketing.ad_entity e on e.id = p.ad_entity_id
    where ${filterClause(f)}
    group by ${col}
    order by spend_inr desc`);
  return res.rows as Array<Record<string, unknown>>;
}

function conversionFilter(f: SpendFilters): SQL {
  const parts: SQL[] = [
    sql`c.app = ${f.app}`,
    sql`c.occurred_at::date between ${f.from} and ${f.to}`,
  ];
  if (f.city) parts.push(sql`c.city = ${f.city}`);
  if (f.category) parts.push(sql`c.category = ${f.category}`);
  return sql.join(parts, sql` and `);
}

export interface CacSummary {
  spend_inr: number;
  first_orders: number;
  all_orders: number;
  blended_cac_inr: number | null;
}

/** Blended CAC = total spend ÷ first-orders in the window. */
export async function cacSummary(f: SpendFilters): Promise<CacSummary> {
  const res = await db.execute(sql`
    with spend as (
      select coalesce(sum(p.spend_inr), 0)::float8 as s
      from marketing.ad_performance_daily p
      join marketing.ad_entity e on e.id = p.ad_entity_id
      where ${filterClause(f)}
    ), fo as (
      select count(*) filter (where c.is_first_order)::float8 as f, count(*)::float8 as a
      from marketing.conversion c
      where ${conversionFilter(f)}
    )
    select spend.s as spend_inr, fo.f as first_orders, fo.a as all_orders,
      case when fo.f > 0 then round((spend.s / fo.f)::numeric, 2)::float8 else null end as blended_cac_inr
    from spend, fo`);
  return res.rows[0] as unknown as CacSummary;
}

/** The hero metric: cost per first order by campaign (matched attribution). */
export async function costPerFirstOrder(
  f: SpendFilters,
): Promise<Array<Record<string, unknown>>> {
  const res = await db.execute(sql`
    with spend as (
      select e.id as ad_entity_id, e.name as campaign, e.city, e.category,
             sum(p.spend_inr)::float8 as spend_inr
      from marketing.ad_performance_daily p
      join marketing.ad_entity e on e.id = p.ad_entity_id
      where ${filterClause(f)}
      group by e.id, e.name, e.city, e.category
    ), fo as (
      select c.attributed_entity_id as ad_entity_id,
             count(*) filter (where c.is_first_order)::float8 as first_orders
      from marketing.conversion c
      where ${conversionFilter(f)} and c.attribution_outcome = 'matched'
      group by c.attributed_entity_id
    )
    select s.campaign, s.city, s.category, s.spend_inr,
      coalesce(fo.first_orders, 0)::float8 as first_orders,
      case when coalesce(fo.first_orders, 0) > 0
        then round((s.spend_inr / fo.first_orders)::numeric, 2)::float8 else null end as cost_per_first_order_inr
    from spend s
    left join fo on fo.ad_entity_id = s.ad_entity_id
    order by s.spend_inr desc`);
  return res.rows as Array<Record<string, unknown>>;
}
