import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { definitionSchema, type Definition } from '../src/marketing/segments/dsl.js';
import { compileMembership, compileCount } from '../src/marketing/segments/compile.js';

const dialect = new PgDialect();

/** Render a drizzle SQL fragment to { text, params }. Confirms user values are
 * always $-parameters (never string-interpolated) and gives a stable snapshot. */
function render(q: SQL): { text: string; params: readonly unknown[] } {
  const { sql, params } = dialect.sqlToQuery(q);
  // Collapse whitespace so snapshots ignore indentation noise.
  return { text: sql.replace(/\s+/g, ' ').trim(), params };
}

const parse = (def: unknown): Definition => definitionSchema.parse(def);

// ── Worked-example definitions (mirror scripts/seed-segments.ts) ──────────────
const dormant30d = parse({
  version: 1,
  group: {
    op: 'AND',
    criteria: [
      { kind: 'order_frequency', op: 'gte', count: 1 },
      { kind: 'order_recency', op: 'gt', days: 30 },
    ],
  },
});

const highValue = parse({
  version: 1,
  group: { op: 'AND', criteria: [{ kind: 'ltv_percentile', op: 'gte', percentile: 90 }] },
});

const cartAbandoners48h = parse({
  version: 1,
  group: {
    op: 'AND',
    criteria: [
      { kind: 'event', event: 'el_add_to_cart', performed: true, window_days: 2 },
      { kind: 'event', event: 'purchase', performed: false, window_days: 2 },
    ],
  },
});

describe('compile — worked-example membership SQL', () => {
  it('dormant_30d = frequency INTERSECT recency, all values parameterised', () => {
    const { text, params } = render(compileMembership('services', dormant30d, true));
    expect(text).toMatchInlineSnapshot(
      `"select distinct user_id from (( select user_id from marketing.conversion where app = $1 and user_id is not null group by user_id having count(*) >= $2) intersect ( select user_id from marketing.conversion where app = $3 and user_id is not null group by user_id having max(occurred_at) < (now() - make_interval(days => $4)))) as members"`,
    );
    expect(params).toEqual(['services', 1, 'services', 30]);
  });

  it('high_value = ntile percentile band', () => {
    const { text, params } = render(compileMembership('services', highValue, true));
    expect(text).toMatchInlineSnapshot(
      `"select distinct user_id from (( select user_id from ( select user_id, ntile(100) over (order by sum(value_inr)) as pct from marketing.conversion where app = $1 and user_id is not null group by user_id ) t where pct > $2)) as members"`,
    );
    expect(params).toEqual(['services', 90]);
  });

  it('cart_abandoners_48h = performed INTERSECT (universe EXCEPT performed)', () => {
    const { text, params } = render(compileMembership('services', cartAbandoners48h, true));
    expect(text).toMatchInlineSnapshot(
      `"select distinct user_id from (( select user_id from marketing.app_event where app = $1 and event_name = $2 and user_id is not null and occurred_at >= (now() - make_interval(days => $3)) group by user_id having count(*) >= $4) intersect (( select distinct user_id from marketing.conversion where app = $5 and user_id is not null union select distinct user_id from marketing.app_event where app = $6 and user_id is not null) except ( select user_id from marketing.app_event where app = $7 and event_name = $8 and user_id is not null and occurred_at >= (now() - make_interval(days => $9)) group by user_id having count(*) >= $10))) as members"`,
    );
    expect(params).toEqual([
      'services',
      'el_add_to_cart',
      2,
      1,
      'services',
      'services',
      'services',
      'purchase',
      2,
      1,
    ]);
  });
});

describe('compile — nested group', () => {
  const nested = parse({
    version: 1,
    group: {
      op: 'AND',
      criteria: [
        { kind: 'order_recency', op: 'gt', days: 30 },
        {
          op: 'OR',
          criteria: [
            { kind: 'monetary', metric: 'total', op: 'gte', value_inr: 5000 },
            { kind: 'ltv_percentile', op: 'gte', percentile: 80 },
          ],
        },
      ],
    },
  });

  it('composes AND(recency, OR(monetary, ltv)) with INTERSECT of a UNION subgroup', () => {
    const { text, params } = render(compileMembership('services', nested, true));
    expect(text).toMatchInlineSnapshot(
      `"select distinct user_id from (( select user_id from marketing.conversion where app = $1 and user_id is not null group by user_id having max(occurred_at) < (now() - make_interval(days => $2))) intersect (( select user_id from marketing.conversion where app = $3 and user_id is not null group by user_id having sum(value_inr) >= $4) union ( select user_id from ( select user_id, ntile(100) over (order by sum(value_inr)) as pct from marketing.conversion where app = $5 and user_id is not null group by user_id ) t where pct > $6))) as members"`,
    );
    expect(params).toEqual(['services', 30, 'services', 5000, 'services', 80]);
  });
});

describe('compile — negation (attribute neq)', () => {
  const attrNeq = parse({
    version: 1,
    group: {
      op: 'AND',
      criteria: [{ kind: 'attribute', field: 'city', op: 'neq', value: 'mumbai' }],
    },
  });

  it('renders universe EXCEPT positive when events are absent (conversion-only universe)', () => {
    const { text, params } = render(compileMembership('services', attrNeq, false));
    expect(text).toMatchInlineSnapshot(
      `"select distinct user_id from ((( select distinct user_id from marketing.conversion where app = $1 and user_id is not null) except ( select distinct user_id from marketing.conversion where app = $2 and user_id is not null and city = any($3::text[])))) as members"`,
    );
    expect(params).toEqual(['services', 'services', ['mumbai']]);
  });
});

describe('compile — count form + guards', () => {
  it('compileCount wraps the same body in count(*)', () => {
    const { text } = render(compileCount('services', highValue, true));
    expect(text.startsWith('select count(*)::int as count from (')).toBe(true);
  });

  it('throws a clean error when events are unavailable but referenced', () => {
    expect(() => compileMembership('services', cartAbandoners48h, false)).toThrow(
      /app_event is not present/,
    );
  });

  it('never string-interpolates the app value (attribute in-list stays a param)', () => {
    const evil = parse({
      version: 1,
      group: {
        op: 'AND',
        criteria: [{ kind: 'attribute', field: 'category', op: 'eq', value: "x'; drop table marketing.segment;--" }],
      },
    });
    const { text, params } = render(compileMembership('services', evil, false));
    expect(text).not.toContain('drop table');
    // The value is bound as a text[] param (sql.param wraps the array atomically),
    // so it appears inside a param array — never in the query text.
    const flat = (params as unknown[]).flat();
    expect(flat).toContain("x'; drop table marketing.segment;--");
  });
});
