import { env } from '../../config/env.js';
import { createChildLogger } from '../../shared/logger/index.js';
import type { Channel, DateRange } from '../ingest/connector.js';
import { buildConnectors } from '../ingest/factory.js';
import { upsertEntities, upsertPerformance } from '../ingest/upsert.js';

const log = createChildLogger({ module: 'ingest-job' });

/** Rolling lookback (default 8 days) absorbs platform attribution restatements. */
export function rollingWindow(days = 8, now: Date = new Date()): DateRange {
  const until = new Date(now);
  const since = new Date(now);
  since.setUTCDate(since.getUTCDate() - (days - 1));
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { since: fmt(since), until: fmt(until) };
}

export interface IngestResult {
  channel: Channel;
  skipped: boolean;
  entities: number;
  perfRows: number;
}

export async function runIngest(channel: Channel): Promise<IngestResult> {
  const connector = buildConnectors().find((c) => c.channel === channel);
  if (!connector) {
    log.warn({ channel }, 'No credentials for channel — skipping ingest');
    return { channel, skipped: true, entities: 0, perfRows: 0 };
  }

  const range = rollingWindow();
  let entities = 0;
  let perfRows = 0;
  for (const app of env.MIL_ENABLED_APPS) {
    const ents = await connector.fetchEntities(app, range);
    const idMap = await upsertEntities(app, ents);
    const perf = await connector.fetchPerformance(app, range);
    perfRows += await upsertPerformance(app, perf, idMap);
    entities += ents.length;
  }
  log.info({ channel, entities, perfRows, range }, 'ingest complete');
  return { channel, skipped: false, entities, perfRows };
}
