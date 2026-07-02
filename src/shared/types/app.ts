import { z } from 'zod';
import { env } from '../../config/env.js';

/**
 * The tenant dimension carried by every top-level table, API filter, and index.
 *
 * The concrete set of valid apps is configured PER INSTANCE via MIL_APP_LIST
 * (see config/env.ts + NEW_INSTANCE.md), so MIL can be cloned for a different
 * marketplace without editing code. `AppKind` is therefore a runtime-validated
 * `string`, not a compile-time literal union — membership is checked against
 * `APPS` (and, in the DB, by the CHECK(app IN …) constraints in drizzle/*.sql).
 */
export type AppKind = string;

export const APPS: readonly string[] = env.MIL_APP_LIST;

export function isAppKind(value: unknown): value is AppKind {
  return typeof value === 'string' && APPS.includes(value);
}

/**
 * Zod schema for an `app` request field: any configured app, defaulting to
 * MIL_DEFAULT_APP. Use in place of the old `z.enum(['services','society'])`.
 */
export const appSchema = z
  .string()
  .refine(isAppKind, {
    message: `app must be one of: ${APPS.join(', ')}`,
  })
  .default(env.MIL_DEFAULT_APP);
