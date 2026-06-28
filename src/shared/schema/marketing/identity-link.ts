import { sql } from 'drizzle-orm';
import { bigint, text, timestamp, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { marketing, idCol, appCol } from './_shared.js';

/**
 * Append-only session→user stitch ledger. When a server-side call (signup or
 * booking) reveals identity for a session, anonymous touches captured at landing
 * get bound to the user retroactively.
 */
export const identityLink = marketing.table(
  'identity_link',
  {
    id: idCol(),
    app: appCol(),
    sessionId: text('session_id').notNull(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_identity_link').on(t.app, t.sessionId, t.userId),
    index('idx_identity_user').on(t.app, t.userId),
    check('identity_link_app_chk', sql`${t.app} in ('services','society')`),
  ],
);
