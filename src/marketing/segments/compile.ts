import { sql, type SQL } from 'drizzle-orm';
import type { AppKind } from '../../shared/types/app.js';
import {
  type Definition,
  type Criterion,
  type Group,
  isGroup,
} from './dsl.js';

/**
 * Compile a segment `Definition` to a single SQL statement that yields DISTINCT
 * user_ids (the segment membership).
 *
 * Strategy: every leaf criterion compiles to a set of user_ids. Groups compose
 * their children as sets: AND = INTERSECT, OR = UNION. Negations (an event with
 * performed=false, or an attribute `neq`) are the complement of their positive
 * form within a `universe` = all user_ids ever seen in conversion ∪ app_event,
 * emitted as `universe EXCEPT <positive>`.
 *
 * SAFETY: all user-supplied values pass through drizzle `sql` template params —
 * no value is ever concatenated into the query text. Only enum-validated column
 * names and windows (integers) reach `sql.raw`, so the DSL zod schema is the
 * trust boundary.
 */

// ── Window helper ─────────────────────────────────────────────────────────────
/** `occurred_at >= now() - <days> days`, parameterised via make_interval. */
function since(days: number): SQL {
  return sql`(now() - make_interval(days => ${days}))`;
}

// ── conversion aggregate-set criteria ─────────────────────────────────────────
function orderRecency(app: AppKind, c: Extract<Criterion, { kind: 'order_recency' }>): SQL {
  const cmp = c.op === 'lte' ? sql`>=` : sql`<`;
  // "last order within N days" (lte) ⇒ max(occurred_at) >= now()-N.
  // "last order older than N days" (gt) ⇒ max(occurred_at) < now()-N.
  return sql`
    select user_id from marketing.conversion
    where app = ${app} and user_id is not null
    group by user_id
    having max(occurred_at) ${cmp} ${since(c.days)}`;
}

function firstOrderAge(app: AppKind, c: Extract<Criterion, { kind: 'first_order_age' }>): SQL {
  const cmp = c.op === 'lte' ? sql`>=` : sql`<`;
  return sql`
    select user_id from marketing.conversion
    where app = ${app} and user_id is not null
    group by user_id
    having min(occurred_at) ${cmp} ${since(c.days)}`;
}

function orderFrequency(
  app: AppKind,
  c: Extract<Criterion, { kind: 'order_frequency' }>,
): SQL {
  const cmp = c.op === 'gte' ? sql`>=` : c.op === 'lte' ? sql`<=` : sql`=`;
  const windowFilter = c.window_days
    ? sql` and occurred_at >= ${since(c.window_days)}`
    : sql``;
  return sql`
    select user_id from marketing.conversion
    where app = ${app} and user_id is not null${windowFilter}
    group by user_id
    having count(*) ${cmp} ${c.count}`;
}

function monetary(app: AppKind, c: Extract<Criterion, { kind: 'monetary' }>): SQL {
  const agg = c.metric === 'total' ? sql`sum(value_inr)` : sql`avg(value_inr)`;
  const cmp = c.op === 'gte' ? sql`>=` : sql`<=`;
  const windowFilter = c.window_days
    ? sql` and occurred_at >= ${since(c.window_days)}`
    : sql``;
  return sql`
    select user_id from marketing.conversion
    where app = ${app} and user_id is not null${windowFilter}
    group by user_id
    having ${agg} ${cmp} ${c.value_inr}`;
}

function ltvPercentile(
  app: AppKind,
  c: Extract<Criterion, { kind: 'ltv_percentile' }>,
): SQL {
  // ntile(100) buckets users by lifetime spend ascending; bucket 100 = top 1%.
  // gte percentile P ⇒ pct > P (users at or above the Pth percentile band).
  return sql`
    select user_id from (
      select user_id, ntile(100) over (order by sum(value_inr)) as pct
      from marketing.conversion
      where app = ${app} and user_id is not null
      group by user_id
    ) t
    where pct > ${c.percentile}`;
}

// ── attribute (conversion row dimension) ──────────────────────────────────────
function attributeColumn(field: 'city' | 'category' | 'attributed_channel'): SQL {
  // enum-validated by zod → safe to raw. Never interpolate user values here.
  return sql.raw(field);
}

function attributePositive(
  app: AppKind,
  c: Extract<Criterion, { kind: 'attribute' }>,
): SQL {
  const col = attributeColumn(c.field);
  const values = Array.isArray(c.value) ? c.value : [c.value];
  // sql.param binds the JS array as ONE text[] param (`= any($n)`), not an
  // expanded row-constructor `($a, $b)` which would be a semantically wrong
  // `= any((...))` in Postgres.
  return sql`
    select distinct user_id from marketing.conversion
    where app = ${app} and user_id is not null
      and ${col} = any(${sql.param(values)}::text[])`;
}

// ── event (app_event) ─────────────────────────────────────────────────────────
function eventPropFilter(props: NonNullable<Extract<Criterion, { kind: 'event' }>['props']>): SQL {
  const parts = props.map((p) => {
    const jsonText = sql`(props->>${p.path})`;
    switch (p.op) {
      case 'eq':
        return sql`${jsonText} = ${String(p.value)}`;
      case 'neq':
        return sql`${jsonText} is distinct from ${String(p.value)}`;
      case 'gte':
        return sql`(${jsonText})::numeric >= ${Number(p.value)}`;
      case 'lte':
        return sql`(${jsonText})::numeric <= ${Number(p.value)}`;
      case 'contains':
        return sql`${jsonText} ilike ${'%' + String(p.value) + '%'}`;
    }
  });
  return sql.join(parts, sql` and `);
}

function eventPerformed(app: AppKind, c: Extract<Criterion, { kind: 'event' }>): SQL {
  const propFilter = c.props?.length ? sql` and ${eventPropFilter(c.props)}` : sql``;
  const minCount = c.min_count ?? 1;
  return sql`
    select user_id from marketing.app_event
    where app = ${app} and event_name = ${c.event} and user_id is not null
      and occurred_at >= ${since(c.window_days)}${propFilter}
    group by user_id
    having count(*) >= ${minCount}`;
}

// ── universe (for negations) ──────────────────────────────────────────────────
/** All user_ids ever seen — conversion ∪ app_event — used as the base set for
 * complement (EXCEPT) of negated criteria. Emitted only when a negation exists. */
function universe(app: AppKind, includeEvents: boolean): SQL {
  const eventsPart = includeEvents
    ? sql`
      union
      select distinct user_id from marketing.app_event
      where app = ${app} and user_id is not null`
    : sql``;
  return sql`
    select distinct user_id from marketing.conversion
    where app = ${app} and user_id is not null${eventsPart}`;
}

// ── Criterion dispatch ────────────────────────────────────────────────────────
interface Ctx {
  app: AppKind;
  eventsAvailable: boolean;
}

/** Compile one leaf criterion to a set-of-user_ids SQL fragment. */
function compileCriterion(c: Criterion, ctx: Ctx): SQL {
  switch (c.kind) {
    case 'order_recency':
      return orderRecency(ctx.app, c);
    case 'first_order_age':
      return firstOrderAge(ctx.app, c);
    case 'order_frequency':
      return orderFrequency(ctx.app, c);
    case 'monetary':
      return monetary(ctx.app, c);
    case 'ltv_percentile':
      return ltvPercentile(ctx.app, c);
    case 'event': {
      if (!ctx.eventsAvailable) {
        throw new Error(
          'segment references app_event but marketing.app_event is not present on this instance',
        );
      }
      const positive = eventPerformed(ctx.app, c);
      if (c.performed) return positive;
      // not-performed = universe EXCEPT performed. Both operands parenthesised so
      // the child's UNION/EXCEPT binds inside this fragment, not across siblings.
      return sql`(${universe(ctx.app, true)}) except (${positive})`;
    }
    case 'attribute': {
      const positive = attributePositive(ctx.app, c);
      if (c.op !== 'neq') return positive;
      return sql`(${universe(ctx.app, ctx.eventsAvailable)}) except (${positive})`;
    }
  }
}

/** Compile a group node (recursively) to a set-of-user_ids SQL fragment. */
function compileGroup(group: Group, ctx: Ctx): SQL {
  const parts = group.criteria.map((node) =>
    isGroup(node) ? compileGroup(node, ctx) : compileCriterion(node, ctx),
  );
  const combinator = group.op === 'AND' ? sql` intersect ` : sql` union `;
  // Parenthesise each child set so INTERSECT/UNION precedence is explicit and a
  // child's own EXCEPT binds inside the child, not across siblings.
  const wrapped = parts.map((p) => sql`(${p})`);
  return sql.join(wrapped, combinator);
}

/**
 * Compile a definition to a statement selecting DISTINCT user_id (the members).
 * `eventsAvailable` must be true iff marketing.app_event exists; the caller
 * checks `to_regclass('marketing.app_event')` and passes the result. When false
 * and the definition references events, this throws a clean error.
 */
export function compileMembership(
  app: AppKind,
  def: Definition,
  eventsAvailable: boolean,
): SQL {
  const body = compileGroup(def.group, { app, eventsAvailable });
  return sql`select distinct user_id from (${body}) as members`;
}

/** Compile a definition to a COUNT of distinct members. */
export function compileCount(
  app: AppKind,
  def: Definition,
  eventsAvailable: boolean,
): SQL {
  const body = compileGroup(def.group, { app, eventsAvailable });
  return sql`select count(*)::int as count from (${body}) as members`;
}
