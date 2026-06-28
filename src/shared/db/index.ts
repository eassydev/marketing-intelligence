import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../../config/env.js';
import * as schema from '../schema/index.js';

// One long-lived pool per process. Tables are declared under pgSchema('marketing')
// so Drizzle always emits fully-qualified `marketing.<table>` names — no reliance
// on search_path, which keeps the Supabase→E2E swap to a single DATABASE_URL change.
export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export const db = drizzle(pool, { schema });

export type Db = typeof db;
