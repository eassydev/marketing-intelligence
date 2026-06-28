/**
 * Explicit SQL migration runner. Applies drizzle/*.sql in lexical order, each in
 * its own transaction, and records applied files in marketing.schema_migrations.
 * Idempotent: already-applied files are skipped. We deliberately do NOT use
 * `drizzle-kit push` — migrations are hand-authored and reviewed (no auto-sync).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { env } from '../src/config/env.js';

// Resolve relative to the working dir (project root locally; /app in the
// container) so the same code finds drizzle/ in both — the compiled file lives
// in dist/scripts/, but drizzle/ is always at the app root.
const migrationsDir = join(process.cwd(), 'drizzle');

async function run(): Promise<void> {
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS marketing');
    await client.query(
      `CREATE TABLE IF NOT EXISTS marketing.schema_migrations (
         filename   TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );

    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const { rows } = await client.query<{ filename: string }>(
      'SELECT filename FROM marketing.schema_migrations',
    );
    const applied = new Set(rows.map((r) => r.filename));

    let appliedCount = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`skip   ${file}`);
        continue;
      }
      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      console.log(`apply  ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO marketing.schema_migrations (filename) VALUES ($1)',
          [file],
        );
        await client.query('COMMIT');
        appliedCount += 1;
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, {
          cause: err,
        });
      }
    }
    console.log(`done — ${appliedCount} new migration(s) applied, ${files.length} total`);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
