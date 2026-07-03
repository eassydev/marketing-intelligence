import { z } from 'zod';

/**
 * Behavioural-segment criteria DSL (version 1).
 *
 * A `Definition` is a single root `Group`. A `Group` combines child criteria (or
 * nested groups) with AND / OR. Criteria are the leaf predicates over a user's
 * conversion history (recency / frequency / monetary / LTV percentile / row
 * attributes) and their product-event stream (app_event).
 *
 * The shape is intentionally closed and small: it maps 1:1 to the SQL CTEs the
 * compiler emits (src/marketing/segments/compile.ts), and every value flows
 * through drizzle `sql` params — never string interpolation — so a definition is
 * safe to accept from an authenticated caller.
 */

// ── Guards ───────────────────────────────────────────────────────────────────
const MAX_DEPTH = 3;
const MAX_CRITERIA = 20;

/** Event names follow the el_* product taxonomy: lower snake, 2–61 chars. */
export const EVENT_NAME_RE = /^[a-z][a-z0-9_]{1,60}$/;

const positiveInt = z.number().int().positive();
const daysInt = positiveInt;

// ── Leaf criteria ────────────────────────────────────────────────────────────
const orderRecency = z.object({
  kind: z.literal('order_recency'),
  op: z.enum(['lte', 'gt']),
  days: daysInt,
});

const firstOrderAge = z.object({
  kind: z.literal('first_order_age'),
  op: z.enum(['lte', 'gt']),
  days: daysInt,
});

const orderFrequency = z.object({
  kind: z.literal('order_frequency'),
  op: z.enum(['gte', 'lte', 'eq']),
  count: z.number().int().nonnegative(),
  window_days: daysInt.optional(),
});

const monetary = z.object({
  kind: z.literal('monetary'),
  metric: z.enum(['total', 'avg']),
  op: z.enum(['gte', 'lte']),
  value_inr: z.number().nonnegative(),
  window_days: daysInt.optional(),
});

const ltvPercentile = z.object({
  kind: z.literal('ltv_percentile'),
  op: z.literal('gte'),
  percentile: z.number().int().min(1).max(99),
});

const eventProp = z.object({
  path: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_]+$/, 'prop path must be a single alphanumeric/underscore key'),
  op: z.enum(['eq', 'neq', 'gte', 'lte', 'contains']),
  value: z.union([z.string().max(256), z.number()]),
});

const event = z.object({
  kind: z.literal('event'),
  event: z.string().regex(EVENT_NAME_RE, 'event must match /^[a-z][a-z0-9_]{1,60}$/'),
  performed: z.boolean(),
  window_days: daysInt,
  min_count: positiveInt.optional(),
  props: z.array(eventProp).max(5).optional(),
});

const attribute = z.object({
  kind: z.literal('attribute'),
  field: z.enum(['city', 'category', 'attributed_channel']),
  op: z.enum(['eq', 'neq', 'in']),
  value: z.union([z.string().max(128), z.array(z.string().max(128)).min(1).max(50)]),
});

export const criterionSchema = z.discriminatedUnion('kind', [
  orderRecency,
  firstOrderAge,
  orderFrequency,
  monetary,
  ltvPercentile,
  event,
  attribute,
]);

export type Criterion = z.infer<typeof criterionSchema>;

// ── Group (recursive) ────────────────────────────────────────────────────────
export interface Group {
  op: 'AND' | 'OR';
  criteria: Array<Criterion | Group>;
}

export const groupSchema: z.ZodType<Group> = z.lazy(() =>
  z.object({
    op: z.enum(['AND', 'OR']),
    criteria: z
      .array(z.union([criterionSchema, groupSchema]))
      .min(1)
      .max(MAX_CRITERIA),
  }),
);

export const definitionSchema = z
  .object({
    version: z.literal(1),
    group: groupSchema,
  })
  .superRefine((def, ctx) => {
    const { depth, count } = measure(def.group);
    if (depth > MAX_DEPTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['group'],
        message: `group nesting exceeds max depth ${MAX_DEPTH} (got ${depth})`,
      });
    }
    if (count > MAX_CRITERIA) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['group'],
        message: `total criteria exceeds max ${MAX_CRITERIA} (got ${count})`,
      });
    }
  });

export type Definition = z.infer<typeof definitionSchema>;

/** A group node is anything with an `op` + `criteria` array. */
export function isGroup(node: Criterion | Group): node is Group {
  return (node as Group).criteria !== undefined && (node as Group).op !== undefined;
}

/** Recursively count leaf criteria and the max nesting depth (root group = 1). */
function measure(group: Group): { depth: number; count: number } {
  let count = 0;
  let maxChildDepth = 0;
  for (const node of group.criteria) {
    if (isGroup(node)) {
      const sub = measure(node);
      count += sub.count;
      maxChildDepth = Math.max(maxChildDepth, sub.depth);
    } else {
      count += 1;
    }
  }
  return { depth: 1 + maxChildDepth, count };
}

/** Does any criterion in the tree reference app_event? (used to gate compilation
 * when the app_event table is absent). */
export function referencesEvents(def: Definition): boolean {
  const walk = (group: Group): boolean =>
    group.criteria.some((node) =>
      isGroup(node) ? walk(node) : node.kind === 'event',
    );
  return walk(def.group);
}

// ── Human labels ─────────────────────────────────────────────────────────────
const OP_WORD: Record<string, string> = {
  lte: '≤',
  gt: '>',
  gte: '≥',
  eq: '=',
  neq: '≠',
  contains: 'contains',
  in: 'in',
};

/** A short human-readable label for a single criterion (UI / audit). */
export function describeCriterion(c: Criterion): string {
  switch (c.kind) {
    case 'order_recency':
      return `last order ${OP_WORD[c.op]} ${c.days}d ago`;
    case 'first_order_age':
      return `first order ${OP_WORD[c.op]} ${c.days}d ago`;
    case 'order_frequency':
      return `orders ${OP_WORD[c.op]} ${c.count}${c.window_days ? ` in ${c.window_days}d` : ' (lifetime)'}`;
    case 'monetary':
      return `${c.metric} spend ${OP_WORD[c.op]} ₹${c.value_inr}${c.window_days ? ` in ${c.window_days}d` : ' (lifetime)'}`;
    case 'ltv_percentile':
      return `LTV percentile ${OP_WORD[c.op]} ${c.percentile}`;
    case 'event': {
      const base = c.performed
        ? `did "${c.event}"${c.min_count ? ` ≥${c.min_count}×` : ''} in ${c.window_days}d`
        : `did NOT do "${c.event}" in ${c.window_days}d`;
      const props = c.props?.length
        ? ` where ${c.props.map((p) => `${p.path} ${OP_WORD[p.op]} ${p.value}`).join(' & ')}`
        : '';
      return base + props;
    }
    case 'attribute': {
      const val = Array.isArray(c.value) ? `[${c.value.join(', ')}]` : c.value;
      return `${c.field} ${OP_WORD[c.op]} ${val}`;
    }
  }
}
