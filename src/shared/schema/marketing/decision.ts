import { sql } from 'drizzle-orm';
import { text, jsonb, timestamp, index, check } from 'drizzle-orm/pg-core';
import { marketing, idCol, appCol } from './_shared.js';

/**
 * Action log + autonomy substrate. DryRunAdActionPort writes rows here with
 * mode='dry_run', status='proposed', executing nothing. LiveAdActionPort (parked)
 * acts only on status='approved' + approved_by.
 */
export const decision = marketing.table(
  'decision',
  {
    id: idCol(),
    app: appCol(),
    proposedAt: timestamp('proposed_at', { withTimezone: true }).notNull().defaultNow(),
    source: text('source'), // rules | llm | human
    channel: text('channel'), // meta | google
    entityLevel: text('entity_level'),
    externalId: text('external_id'),
    stateSnapshot: jsonb('state_snapshot'),
    actionType: text('action_type'), // pause | set_budget | adjust_tcpa
    actionParams: jsonb('action_params'),
    mode: text('mode').notNull().default('dry_run'), // dry_run | live
    status: text('status').notNull().default('proposed'), // proposed|approved|executed|rejected
    reason: text('reason'),
    correlationId: text('correlation_id'),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    result: jsonb('result'),
  },
  (t) => [
    index('idx_decision_status').on(t.app, t.status, t.proposedAt),
    check('decision_app_chk', sql`${t.app} in ('services','society')`),
    check('decision_mode_chk', sql`${t.mode} in ('dry_run','live')`),
    check(
      'decision_status_chk',
      sql`${t.status} in ('proposed','approved','executed','rejected')`,
    ),
  ],
);
