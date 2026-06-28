import { defineConfig } from 'drizzle-kit';
import { existsSync } from 'node:fs';

// Use compiled JS schema when running inside the production Docker image
// (drizzle-kit's CJS resolver can't load TS source whose imports use `.js`
// extensions). Fall back to TS source for local development.
const compiledSchema = './dist/src/shared/schema/index.js';
const schema = existsSync(compiledSchema)
  ? compiledSchema
  : './src/shared/schema/index.ts';

// NOTE: `drizzle-kit generate` is used ONLY to draft SQL for review. The
// canonical migration path is the hand-authored files in ./drizzle applied by
// scripts/migrate.ts. We never run `drizzle-kit push` (no auto-sync in prod).
export default defineConfig({
  schema,
  out: './drizzle',
  dialect: 'postgresql',
  schemaFilter: ['marketing'],
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://mil:mil@localhost:5432/mil',
  },
});
