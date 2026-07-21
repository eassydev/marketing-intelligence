import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../shared/db/index.js';
import { env } from '../../config/env.js';
import type { AppKind } from '../../shared/types/app.js';

/**
 * Campaign-attributed full funnel (Phase 6): impressions → ad clicks →
 * first-party clicks → installs → registrations → add-to-cart → orders/revenue,
 * one row per utm_campaign. Covers ads AND offline/society/QR campaigns —
 * anything with a touch. Kept in its own file (like event-queries.ts) to avoid
 * merge conflicts with sibling serving modules.
 *
 * SEMANTICS + DOCUMENTED APPROXIMATIONS
 * - The campaign universe is the UNION of utm_campaigns seen on touches in the
 *   window and ad_entity names with spend in the window, joined case-insensitively
 *   on lower(name) = lower(utm_campaign) — the same name-matching convention as
 *   attribution/map-touch-to-entity.ts. Campaigns with no ad entity (offline/QR)
 *   report impressions / ad_clicks / ad_spend_inr as NULL, not 0.
 * - Ad-side sums do not filter on ad_entity.level, matching spendBreakdown()'s
 *   'campaign' dimension (perf facts are ingested at one level per channel).
 * - Event/order stages attribute per identity: the IDENTITY_KEY discipline from
 *   event-queries.ts (user_id, else identity_link-stitched user, else session)
 *   joined to that identity's LAST utm_campaign touch within
 *   MIL_CLICK_LOOKBACK_DAYS before the event — a last-touch approximation of
 *   resolve.ts (which prioritises user_id over session_id; here both collapse
 *   into one key). Identities with no in-lookback campaign touch drop out
 *   (organic), so stage counts are attributed counts, not app-wide totals.
 * - utm_campaign/channel/medium filters narrow ONLY the campaign universe /
 *   final row selection. Last-touch winners are always decided against the
 *   FULL campaign-touch pool, so a filtered row shows the same numbers as the
 *   same campaign's row in the unfiltered listing, and summing filtered calls
 *   never double-counts a conversion across campaigns.
 * - installs / registrations / add_to_cart count each identity once per stage
 *   (first occurrence in-window); orders/revenue count every conversion row.
 * - `medium` filters touches on utm_medium; ad platforms carry no medium, so a
 *   medium filter restricts the universe to touch-bearing campaigns.
 */

export interface CampaignFunnelFilters {
  app: AppKind;
  from: string; // YYYY-MM-DD (inclusive)
  to: string; // YYYY-MM-DD (inclusive)
  utmCampaign?: string;
  channel?: string; // 'google' | 'meta' | 'ctwa' (validated at the route)
  medium?: string;
}

export interface CampaignFunnelRow {
  utm_campaign: string;
  impressions: number | null;
  ad_clicks: number | null;
  first_party_clicks: number;
  installs: number;
  registrations: number;
  add_to_cart: number;
  orders: number;
  revenue_inr: number;
  ad_spend_inr: number | null;
}

/** Ranked campaign rows are capped — dashboards page beyond this via filters. */
const MAX_CAMPAIGNS = 100;

/** Funnel event stages (el_* taxonomy) in stage order. */
const STAGE_EVENTS = ['el_first_open', 'el_signup', 'el_add_to_cart'] as const;

/** Identity stitch — mirrors event-queries.ts, parameterised by row alias. */
const identityJoin = (alias: string): SQL => sql`
  left join marketing.identity_link il
    on il.app = ${sql.raw(alias)}.app and il.session_id = ${sql.raw(alias)}.session_id`;

const identityKey = (alias: string): SQL =>
  sql`coalesce(${sql.raw(alias)}.user_id::text, il.user_id::text, 'sid:' || ${sql.raw(alias)}.session_id)`;

/** occurred_at ∈ [from 00:00, to+1 00:00) — same day-window shape as event-queries. */
const window = (col: SQL, f: CampaignFunnelFilters): SQL =>
  sql`${col} >= (${f.from}::date)::timestamptz and ${col} < ((${f.to}::date + 1))::timestamptz`;

/** Touch-side filters for the campaign UNIVERSE only (touch_campaigns) —
 * never applied to touches_attr, which must see every campaign touch. */
function touchFilters(f: CampaignFunnelFilters): SQL {
  const parts: SQL[] = [sql`t.utm_campaign is not null`];
  // Match either the raw utm value or the campaign it resolves to, so filtering
  // by campaign name still finds touches that carried the numeric ad id.
  if (f.utmCampaign)
    parts.push(
      sql`(lower(t.utm_campaign) = lower(${f.utmCampaign}) or lower(ca.campaign_name) = lower(${f.utmCampaign}))`,
    );
  if (f.channel) parts.push(sql`t.channel = ${f.channel}`);
  if (f.medium) parts.push(sql`t.utm_medium = ${f.medium}`);
  return sql.join(parts, sql` and `);
}

export async function campaignFunnel(
  f: CampaignFunnelFilters,
): Promise<CampaignFunnelRow[]> {
  const lookbackDays = env.MIL_CLICK_LOOKBACK_DAYS;

  // Ad-side filters (name-matched to utm_campaign; no medium concept).
  // Filters now target the RESOLVED campaign (ec.*), not the ad-level entity —
  // filtering by campaign name must not depend on which level the perf fact
  // hangs off.
  const adParts: SQL[] = [sql`ec.campaign_name is not null`];
  if (f.utmCampaign) adParts.push(sql`lower(ec.campaign_name) = lower(${f.utmCampaign})`);
  if (f.channel) adParts.push(sql`e.channel = ${f.channel}`);
  const adFilters = sql.join(adParts, sql` and `);

  // A medium filter is touch-only, so ad-only campaigns cannot satisfy it:
  // downgrade the universe join from FULL OUTER to LEFT (touch side drives).
  const universeJoin = f.medium ? sql`left join` : sql`full outer join`;

  const res = await db.execute(sql`
    with entity_campaign as (
      -- Resolve EVERY ad entity to its campaign-level ancestor, keyed by
      -- external_id. Both sides of the funnel canonicalise through this, which
      -- is what lets a touch join to its spend:
      --   * Ads pass Meta's numeric campaign id as utm_campaign, while perf
      --     facts hang off AD-level entities whose names differ from the
      --     campaign's ("2 Bathroom Cleaning" vs "el_June26_Mumbai_Campaign").
      --     Matching on lower(name) = lower(utm_campaign) therefore never hit,
      --     leaving paid campaigns permanently at first_party_clicks = 0.
      --   * Names are also inconsistent across levels ("2 Bathroom Cleaning" /
      --     "2 BathroomCleaning" / "2BathroomCleaning"), so ids are the only
      --     stable key.
      -- Two hops covers ad → adset → campaign; a campaign resolves to itself.
      select e.id as entity_id,
             lower(e.external_id) as ext_key,
             lower(e.name) as name_key,
             lower(coalesce(c2.external_id, c1.external_id, e.external_id)) as campaign_key,
             coalesce(c2.name, c1.name, e.name) as campaign_name
      from marketing.ad_entity e
      left join marketing.ad_entity c1
        on c1.app = e.app and c1.channel = e.channel
       and c1.external_id = e.parent_external_id
      left join marketing.ad_entity c2
        on c2.app = c1.app and c2.channel = c1.channel
       and c2.external_id = c1.parent_external_id
      where e.app = ${f.app}
    ),
    campaign_alias as (
      -- Every way a touch might name its campaign → the campaign it belongs to.
      -- Both aliases are required: Meta ads emit the numeric id, while short
      -- links (/r/:slug), offline and QR campaigns emit the NAME (the original
      -- map-touch-to-entity convention). DISTINCT ON collapses names shared by
      -- several entities (e.g. the same name at ad and adset level) so a join
      -- on alias can never fan out and multiply first_party_clicks.
      select distinct on (alias) alias, campaign_key, campaign_name
      from (
        select ext_key as alias, campaign_key, campaign_name
          from entity_campaign where ext_key is not null
        union all
        select name_key as alias, campaign_key, campaign_name
          from entity_campaign where name_key is not null
      ) a
      order by alias, campaign_key
    ),
    touch_campaigns as (
      -- Campaign universe, touch side. utm_campaign is resolved to its campaign
      -- via either alias; unmatched values keep the raw string so offline/QR/
      -- society campaigns (no ad entity at all) still appear.
      select coalesce(ca.campaign_key, lower(t.utm_campaign)) as campaign_key,
             min(coalesce(ca.campaign_name, t.utm_campaign)) as utm_campaign,
             count(*) filter (where t.touch_type = 'first_party_click')::float8
               as first_party_clicks
      from marketing.attribution_touch t
      left join campaign_alias ca on ca.alias = lower(t.utm_campaign)
      where t.app = ${f.app} and ${window(sql`t.occurred_at`, f)} and ${touchFilters(f)}
      group by 1
    ),
    ad_campaigns as (
      -- Campaign universe, ad side: perf facts are ad-level, rolled up to the
      -- campaign ancestor. Grouping by the campaign id (not the entity name)
      -- also collapses the duplicate-name entities that previously split spend.
      select ec.campaign_key,
             min(ec.campaign_name) as utm_campaign,
             sum(p.impressions)::float8 as impressions,
             sum(p.clicks)::float8 as ad_clicks,
             sum(p.spend_inr)::float8 as ad_spend_inr
      from marketing.ad_performance_daily p
      join marketing.ad_entity e on e.id = p.ad_entity_id
      join entity_campaign ec on ec.entity_id = e.id
      where p.app = ${f.app} and p.stat_date between ${f.from} and ${f.to} and ${adFilters}
      group by 1
    ),
    campaigns as (
      select coalesce(tc.campaign_key, ac.campaign_key) as campaign_key,
             coalesce(tc.utm_campaign, ac.utm_campaign) as utm_campaign,
             coalesce(tc.first_party_clicks, 0)::float8 as first_party_clicks,
             ac.impressions, ac.ad_clicks, ac.ad_spend_inr
      from touch_campaigns tc
      ${universeJoin} ad_campaigns ac on ac.campaign_key = tc.campaign_key
      -- utm_campaign tiebreak keeps the LIMIT boundary deterministic when many
      -- campaigns share a rank value (e.g. offline campaigns with no spend).
      order by coalesce(tc.first_party_clicks, 0) + coalesce(ac.ad_spend_inr, 0) desc,
               coalesce(tc.utm_campaign, ac.utm_campaign)
      limit ${MAX_CAMPAIGNS}
    ),
    touches_attr as (
      -- Attribution source: ALL campaign touches per identity (deliberately
      -- NOT narrowed by the request filters — winners must be decided against
      -- the full touch set, or a filtered query would silently switch from
      -- last-touch to "any touch of the filtered campaign" and double-count),
      -- window widened backwards by the lookback so an event on the from-date
      -- can still match.
      select ${identityKey('t')} as id,
             coalesce(ca.campaign_key, lower(t.utm_campaign)) as campaign_key,
             t.occurred_at
      from marketing.attribution_touch t
      ${identityJoin('t')}
      left join campaign_alias ca on ca.alias = lower(t.utm_campaign)
      where t.app = ${f.app}
        and t.occurred_at >= ((${f.from}::date - ${lookbackDays}::int))::timestamptz
        and t.occurred_at < ((${f.to}::date + 1))::timestamptz
        and t.utm_campaign is not null
        and ${identityKey('t')} is not null
    ),
    ev as (
      -- First in-window occurrence of each funnel stage per identity.
      select ${identityKey('e')} as id, e.event_name, min(e.occurred_at) as t
      from marketing.app_event e
      ${identityJoin('e')}
      where e.app = ${f.app} and ${window(sql`e.occurred_at`, f)}
        and e.event_name in (${sql.join(STAGE_EVENTS.map((s) => sql`${s}`), sql`, `)})
        and ${identityKey('e')} is not null
      group by 1, 2
    ),
    ev_attr as (
      -- Last campaign touch within the lookback before the stage event wins.
      select distinct on (ev.id, ev.event_name) ev.event_name, ta.campaign_key
      from ev
      join touches_attr ta
        on ta.id = ev.id
       and ta.occurred_at <= ev.t
       and ta.occurred_at >= ev.t - make_interval(days => ${lookbackDays}::int)
      order by ev.id, ev.event_name, ta.occurred_at desc
    ),
    ev_counts as (
      select campaign_key,
             count(*) filter (where event_name = 'el_first_open')::float8 as installs,
             count(*) filter (where event_name = 'el_signup')::float8 as registrations,
             count(*) filter (where event_name = 'el_add_to_cart')::float8 as add_to_cart
      from ev_attr
      group by 1
    ),
    conv as (
      select c.id as conv_id, ${identityKey('c')} as id, c.occurred_at, c.value_inr
      from marketing.conversion c
      ${identityJoin('c')}
      where c.app = ${f.app} and ${window(sql`c.occurred_at`, f)}
        and ${identityKey('c')} is not null
    ),
    conv_attr as (
      select distinct on (conv.conv_id) conv.value_inr, ta.campaign_key
      from conv
      join touches_attr ta
        on ta.id = conv.id
       and ta.occurred_at <= conv.occurred_at
       and ta.occurred_at >= conv.occurred_at - make_interval(days => ${lookbackDays}::int)
      order by conv.conv_id, ta.occurred_at desc
    ),
    conv_counts as (
      select campaign_key,
             count(*)::float8 as orders,
             coalesce(sum(value_inr), 0)::float8 as revenue_inr
      from conv_attr
      group by 1
    )
    select c.utm_campaign,
           c.impressions,
           c.ad_clicks,
           c.first_party_clicks,
           coalesce(ec.installs, 0)::float8 as installs,
           coalesce(ec.registrations, 0)::float8 as registrations,
           coalesce(ec.add_to_cart, 0)::float8 as add_to_cart,
           coalesce(cc.orders, 0)::float8 as orders,
           coalesce(cc.revenue_inr, 0)::float8 as revenue_inr,
           c.ad_spend_inr
    from campaigns c
    left join ev_counts ec on ec.campaign_key = c.campaign_key
    left join conv_counts cc on cc.campaign_key = c.campaign_key
    order by c.first_party_clicks + coalesce(c.ad_spend_inr, 0) desc, c.utm_campaign`);

  return res.rows as unknown as CampaignFunnelRow[];
}
