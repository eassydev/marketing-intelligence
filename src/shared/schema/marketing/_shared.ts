import { pgSchema, bigint, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * All MIL tables live under the `marketing` Postgres schema. Declaring tables
 * via this object means Drizzle emits fully-qualified `marketing.<table>` names,
 * so queries never depend on search_path (keeps Supabase↔E2E portable).
 */
export const marketing = pgSchema('marketing');

/** BIGINT identity PK, per the build spec. Drizzle omits it on insert. */
export const idCol = () =>
  bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity();

/** The tenant dimension carried by every top-level table. */
export const appCol = () => text('app').notNull();

export const createdAtCol = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const updatedAtCol = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
