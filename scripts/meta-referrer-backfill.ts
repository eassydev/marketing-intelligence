/**
 * Decrypt Meta install referrers already stored in marketing.attribution_touch.
 *
 *   npm run backfill:meta-referrer            # dry run: reports, writes nothing
 *   npm run backfill:meta-referrer -- --apply # writes
 *
 * In the prod container (no tsx): node dist/scripts/meta-referrer-backfill.js [--apply]
 */
import { runMetaReferrerBackfill } from '../src/marketing/jobs/meta-referrer-backfill.js';
import { pool } from '../src/shared/db/index.js';

const apply = process.argv.includes('--apply');

try {
  const stats = await runMetaReferrerBackfill({ apply });
  console.log(JSON.stringify(stats, null, 2));
} catch (err) {
  console.error('meta referrer backfill failed:', (err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
