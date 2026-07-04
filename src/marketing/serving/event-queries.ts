import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../shared/db/index.js';
import type { AppKind } from '../../shared/types/app.js';

/**
 * Serving queries over marketing.app_event (DAU / funnel / retention). Kept in a
 * separate file from queries.ts to minimise merge conflict with the concurrent
 * feat/mil-capi-ltv branch.
 *
 * IDENTITY RESOLUTION (shared by all three): events carry either a user_id (the
 * app knew the user) or only a session_id (anonymous). We stitch anonymous
 * sessions to their user via the append-only identity_link ledger and collapse
 * both into ONE identity key per row:
 *
 *   COALESCE(e.user_id::text, il.user_id::text, 'sid:' || e.session_id)
 *
 * so a user counts once whether a given event was pre- or post-login. Every
 * query also constrains occurred_at BETWEEN so Postgres can prune partitions.
 */

/** LEFT JOIN that surfaces the stitched user_id for anonymous sessions. */
const IDENTITY_JOIN = sql`
  left join marketing.identity_link il
    on il.app = e.app and il.session_id = e.session_id`;

/** The single per-row identity key. Rows with neither id resolve to NULL and
 * are excluded via a WHERE guard in each query. */
const IDENTITY_KEY = sql`coalesce(e.user_id::text, il.user_id::text, 'sid:' || e.session_id)`;

export interface EventFilters {
  app: AppKind;
  from: string; // YYYY-MM-DD (inclusive)
  to: string; // YYYY-MM-DD (inclusive)
}

/** occurred_at window as an IST day range [from 00:00, to+1 00:00) in +05:30. */
function windowClause(f: EventFilters): SQL {
  return sql`e.app = ${f.app}
    and e.occurred_at >= (${f.from}::date)::timestamptz
    and e.occurred_at <  ((${f.to}::date + 1))::timestamptz`;
}

// ── DAU ─────────────────────────────────────────────────────────────────────
export interface DauData {
  daily: Array<{ date: string; dau: number; events: number }>;
  totals: { unique_users: number; events: number };
  by_event: Array<{ event_name: string; count: number }>;
}

export async function dau(f: EventFilters): Promise<DauData> {
  const daily = await db.execute(sql`
    select occurred_at::date::text as date,
           count(distinct ${IDENTITY_KEY})::int as dau,
           count(*)::int as events
    from marketing.app_event e
    ${IDENTITY_JOIN}
    where ${windowClause(f)} and ${IDENTITY_KEY} is not null
    group by 1
    order by 1`);

  const totals = await db.execute(sql`
    select count(distinct ${IDENTITY_KEY})::int as unique_users,
           count(*)::int as events
    from marketing.app_event e
    ${IDENTITY_JOIN}
    where ${windowClause(f)} and ${IDENTITY_KEY} is not null`);

  const byEvent = await db.execute(sql`
    select e.event_name, count(*)::int as count
    from marketing.app_event e
    where ${windowClause(f)}
    group by e.event_name
    order by count desc
    limit 50`);

  return {
    daily: daily.rows as DauData['daily'],
    totals: (totals.rows[0] as DauData['totals']) ?? { unique_users: 0, events: 0 },
    by_event: byEvent.rows as DauData['by_event'],
  };
}

// ── Funnel ──────────────────────────────────────────────────────────────────
export interface FunnelStep {
  step: number;
  event_name: string;
  users: number;
  pct_of_first: number;
  pct_of_prev: number;
}

/**
 * Ordered-conversion funnel. step1 = the first time each identity fired event1
 * within the window; stepN = the first time it fired eventN STRICTLY AFTER its
 * step(N-1) time. Out-of-order events therefore do not count. Built as chained
 * CTEs, one per step.
 */
export async function funnel(f: EventFilters, steps: string[]): Promise<FunnelStep[]> {
  // step0 CTE: first occurrence of steps[0] per identity in-window.
  const ctes: SQL[] = [
    sql`s0 as (
      select ${IDENTITY_KEY} as id, min(e.occurred_at) as t
      from marketing.app_event e
      ${IDENTITY_JOIN}
      where ${windowClause(f)} and e.event_name = ${steps[0]}
        and ${IDENTITY_KEY} is not null
      group by 1
    )`,
  ];
  for (let i = 1; i < steps.length; i += 1) {
    const prev = `s${i - 1}`;
    const cur = `s${i}`;
    ctes.push(sql`${sql.raw(cur)} as (
      select ${IDENTITY_KEY} as id, min(e.occurred_at) as t
      from marketing.app_event e
      ${IDENTITY_JOIN}
      join ${sql.raw(prev)} on ${sql.raw(prev)}.id = ${IDENTITY_KEY}
      where ${windowClause(f)} and e.event_name = ${steps[i]!}
        and e.occurred_at > ${sql.raw(prev)}.t
        and ${IDENTITY_KEY} is not null
      group by 1
    )`);
  }
  // Count rows in each step CTE.
  const counts: SQL[] = steps.map(
    (_, i) => sql`(select count(*)::int from ${sql.raw(`s${i}`)}) as c${sql.raw(String(i))}`,
  );
  const res = await db.execute(sql`
    with ${sql.join(ctes, sql`, `)}
    select ${sql.join(counts, sql`, `)}`);
  const row = res.rows[0] as Record<string, number>;

  const out: FunnelStep[] = [];
  const first = Number(row.c0 ?? 0);
  let prevCount = first;
  for (let i = 0; i < steps.length; i += 1) {
    const users = Number(row[`c${i}`] ?? 0);
    out.push({
      step: i + 1,
      event_name: steps[i]!,
      users,
      pct_of_first: first > 0 ? round((users / first) * 100) : 0,
      pct_of_prev: i === 0 ? 100 : prevCount > 0 ? round((users / prevCount) * 100) : 0,
    });
    prevCount = users;
  }
  return out;
}

// ── Retention ───────────────────────────────────────────────────────────────
export interface RetentionCohort {
  cohort_date: string;
  size: number;
  retained: Record<string, number>; // { d1: n, d7: n, ... }
  rates: Record<string, number>; // { d1: pct, d7: pct, ... }
}
export interface RetentionData {
  days: number[];
  cohorts: RetentionCohort[];
}

/**
 * Cohort retention. Cohort entry = the identity's first in-window activity date
 * (cohort='first_seen') or the date of its first occurrence of the named cohort
 * event. For each cohort date and each N in `days`, retained = identities that
 * had ANY activity exactly N days later.
 */
export async function retention(
  f: EventFilters,
  days: number[],
  cohort: string,
): Promise<RetentionData> {
  // Cohort-entry CTE: first activity (or first cohort-event) date per identity.
  const cohortFilter =
    cohort === 'first_seen' ? sql`` : sql` and e.event_name = ${cohort}`;
  const perDay = days.map(
    (d) =>
      sql`count(distinct a.id) filter (where a.d = c.cohort_date + ${d}::int)::int as d${sql.raw(String(d))}`,
  );

  const res = await db.execute(sql`
    with cohorts as (
      select ${IDENTITY_KEY} as id,
             min((e.occurred_at at time zone 'Asia/Kolkata')::date) as cohort_date
      from marketing.app_event e
      ${IDENTITY_JOIN}
      where ${windowClause(f)}${cohortFilter} and ${IDENTITY_KEY} is not null
      group by 1
    ),
    activity as (
      select ${IDENTITY_KEY} as id,
             (e.occurred_at at time zone 'Asia/Kolkata')::date as d
      from marketing.app_event e
      ${IDENTITY_JOIN}
      where ${windowClause(f)} and ${IDENTITY_KEY} is not null
      group by 1, 2
    )
    select c.cohort_date::text as cohort_date,
           count(distinct c.id)::int as size,
           ${sql.join(perDay, sql`, `)}
    from cohorts c
    join activity a on a.id = c.id
    group by c.cohort_date
    order by c.cohort_date`);

  const cohorts: RetentionCohort[] = (res.rows as Array<Record<string, unknown>>).map((r) => {
    const size = Number(r.size);
    const retained: Record<string, number> = {};
    const rates: Record<string, number> = {};
    for (const d of days) {
      const n = Number(r[`d${d}`] ?? 0);
      retained[`d${d}`] = n;
      rates[`d${d}`] = size > 0 ? round((n / size) * 100) : 0;
    }
    return { cohort_date: String(r.cohort_date), size, retained, rates };
  });

  return { days, cohorts };
}

/** Round to 2 decimals (percentages). */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}
