import { describe, it, expect } from 'vitest';
import {
  definitionSchema,
  describeCriterion,
  referencesEvents,
  type Definition,
  type Criterion,
} from '../src/marketing/segments/dsl.js';

const wrap = (criteria: unknown[]): unknown => ({
  version: 1,
  group: { op: 'AND', criteria },
});

describe('segment DSL (zod)', () => {
  it('accepts a simple single-criterion definition', () => {
    const def = wrap([{ kind: 'order_recency', op: 'gt', days: 30 }]);
    expect(definitionSchema.safeParse(def).success).toBe(true);
  });

  it('accepts every criterion kind', () => {
    const def = wrap([
      { kind: 'order_recency', op: 'lte', days: 7 },
      { kind: 'first_order_age', op: 'gt', days: 90 },
      { kind: 'order_frequency', op: 'gte', count: 2 },
      { kind: 'order_frequency', op: 'lte', count: 5, window_days: 30 },
      { kind: 'monetary', metric: 'total', op: 'gte', value_inr: 5000 },
      { kind: 'monetary', metric: 'avg', op: 'lte', value_inr: 999.5, window_days: 60 },
      { kind: 'ltv_percentile', op: 'gte', percentile: 90 },
      {
        kind: 'event',
        event: 'el_add_to_cart',
        performed: true,
        window_days: 2,
        min_count: 1,
        props: [{ path: 'city', op: 'eq', value: 'mumbai' }],
      },
      { kind: 'attribute', field: 'city', op: 'in', value: ['mumbai', 'pune'] },
    ]);
    const res = definitionSchema.safeParse(def);
    expect(res.success).toBe(true);
  });

  it('accepts a nested group up to depth 3', () => {
    const def = {
      version: 1,
      group: {
        op: 'AND',
        criteria: [
          { kind: 'order_recency', op: 'gt', days: 30 },
          {
            op: 'OR',
            criteria: [
              { kind: 'monetary', metric: 'total', op: 'gte', value_inr: 1000 },
              {
                op: 'AND',
                criteria: [{ kind: 'ltv_percentile', op: 'gte', percentile: 80 }],
              },
            ],
          },
        ],
      },
    };
    expect(definitionSchema.safeParse(def).success).toBe(true);
  });

  it('rejects a wrong version', () => {
    const def = { version: 2, group: { op: 'AND', criteria: [{ kind: 'order_recency', op: 'gt', days: 1 }] } };
    expect(definitionSchema.safeParse(def).success).toBe(false);
  });

  it('rejects an unknown criterion kind', () => {
    expect(definitionSchema.safeParse(wrap([{ kind: 'moon_phase', op: 'gt', days: 1 }])).success).toBe(false);
  });

  it('rejects days <= 0', () => {
    expect(definitionSchema.safeParse(wrap([{ kind: 'order_recency', op: 'gt', days: 0 }])).success).toBe(false);
    expect(definitionSchema.safeParse(wrap([{ kind: 'order_recency', op: 'gt', days: -5 }])).success).toBe(false);
  });

  it('rejects an invalid order_recency op', () => {
    expect(definitionSchema.safeParse(wrap([{ kind: 'order_recency', op: 'gte', days: 5 }])).success).toBe(false);
  });

  it('rejects a percentile out of 1..99', () => {
    expect(definitionSchema.safeParse(wrap([{ kind: 'ltv_percentile', op: 'gte', percentile: 0 }])).success).toBe(false);
    expect(definitionSchema.safeParse(wrap([{ kind: 'ltv_percentile', op: 'gte', percentile: 100 }])).success).toBe(false);
  });

  it('rejects a malformed event name', () => {
    expect(definitionSchema.safeParse(wrap([{ kind: 'event', event: 'BadName', performed: true, window_days: 2 }])).success).toBe(false);
    expect(definitionSchema.safeParse(wrap([{ kind: 'event', event: '1leading', performed: true, window_days: 2 }])).success).toBe(false);
  });

  it('rejects an empty group', () => {
    expect(definitionSchema.safeParse({ version: 1, group: { op: 'AND', criteria: [] } }).success).toBe(false);
  });

  it('rejects nesting deeper than depth 3', () => {
    const deep = {
      version: 1,
      group: {
        op: 'AND',
        criteria: [
          {
            op: 'AND',
            criteria: [
              {
                op: 'AND',
                criteria: [
                  { op: 'AND', criteria: [{ kind: 'order_recency', op: 'gt', days: 1 }] },
                ],
              },
            ],
          },
        ],
      },
    };
    expect(definitionSchema.safeParse(deep).success).toBe(false);
  });

  it('rejects more than 20 total criteria', () => {
    const many = Array.from({ length: 21 }, () => ({ kind: 'order_recency', op: 'gt', days: 1 }));
    expect(definitionSchema.safeParse(wrap(many)).success).toBe(false);
  });

  it('rejects an attribute with an empty array value', () => {
    expect(definitionSchema.safeParse(wrap([{ kind: 'attribute', field: 'city', op: 'in', value: [] }])).success).toBe(false);
  });
});

describe('referencesEvents', () => {
  it('is true when a nested group contains an event criterion', () => {
    const def = definitionSchema.parse(
      wrap([
        { kind: 'order_recency', op: 'gt', days: 30 },
        { op: 'OR', criteria: [{ kind: 'event', event: 'el_add_to_cart', performed: false, window_days: 2 }] },
      ]),
    ) as Definition;
    expect(referencesEvents(def)).toBe(true);
  });

  it('is false for a purely conversion-based definition', () => {
    const def = definitionSchema.parse(wrap([{ kind: 'order_recency', op: 'gt', days: 30 }])) as Definition;
    expect(referencesEvents(def)).toBe(false);
  });
});

describe('describeCriterion', () => {
  it('labels each kind readably', () => {
    const cases: Array<[Criterion, RegExp]> = [
      [{ kind: 'order_recency', op: 'gt', days: 30 }, /last order > 30d/],
      [{ kind: 'first_order_age', op: 'lte', days: 7 }, /first order ≤ 7d/],
      [{ kind: 'order_frequency', op: 'gte', count: 2 }, /orders ≥ 2 \(lifetime\)/],
      [{ kind: 'monetary', metric: 'total', op: 'gte', value_inr: 5000 }, /total spend ≥ ₹5000/],
      [{ kind: 'ltv_percentile', op: 'gte', percentile: 90 }, /LTV percentile ≥ 90/],
      [{ kind: 'event', event: 'el_purchase', performed: false, window_days: 2 }, /did NOT do "el_purchase"/],
      [{ kind: 'attribute', field: 'city', op: 'in', value: ['mumbai', 'pune'] }, /city in \[mumbai, pune\]/],
    ];
    for (const [c, re] of cases) {
      expect(describeCriterion(c)).toMatch(re);
    }
  });
});
