import { sql } from 'drizzle-orm';
import { text, numeric, jsonb, timestamp, index, check } from 'drizzle-orm/pg-core';
import { marketing, idCol, appCol } from './_shared.js';

/** PARKED (Module B — anomaly/alert layer). Table created now, no jobs yet. */
export const alert = marketing.table(
  'alert',
  {
    id: idCol(),
    app: appCol(),
    firedAt: timestamp('fired_at', { withTimezone: true }).notNull(),
    severity: text('severity'), // info | warn | critical
    ruleKey: text('rule_key').notNull(),
    scope: jsonb('scope'), // { city, category, entity_id }
    metric: text('metric'),
    observed: numeric('observed', { precision: 14, scale: 2 }),
    threshold: numeric('threshold', { precision: 14, scale: 2 }),
    message: text('message'),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  },
  (t) => [
    index('idx_alert_app_fired').on(t.app, t.firedAt),
    check('alert_app_chk', sql`${t.app} in ('services','society')`),
  ],
);
