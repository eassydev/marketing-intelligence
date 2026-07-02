/**
 * mil-capi-meta job orchestration. Selects resolved Purchase conversions not
 * yet uploaded, pushes them to Meta CAPI in batches, and marks capi_uploaded_at
 * only for batches Meta accepted (HTTP 200). Env-gated by META_CAPI_ENABLED —
 * dark by default, so scheduling it is harmless until the flag is flipped.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db } from '../../shared/db/index.js';
import { conversion } from '../../shared/schema/marketing/conversion.js';
import { createChildLogger } from '../../shared/logger/index.js';
import type { AppKind } from '../../shared/types/app.js';
import { buildPurchaseEvent, sendEvents, type ConversionRow } from './meta-capi.js';

const log = createChildLogger({ module: 'capi-upload' });

const BATCH = 500; // events per Meta request (Meta max is 1000 — keep headroom)
const MAX_PER_RUN = 5000; // safety cap on rows selected per app per run

export interface CapiUploadResult {
  skipped?: 'disabled' | 'no_token';
  apps?: Array<{ app: AppKind; selected: number; uploaded: number }>;
}

interface PendingRow {
  order_id: string;
  user_id: number | string | null;
  value_inr: string;
  occurred_at: Date;
  action_source: string | null;
  city: string | null;
  fbc: string | null;
  fbp: string | null;
}

export async function runCapiUpload(): Promise<CapiUploadResult> {
  if (!env.META_CAPI_ENABLED) {
    log.info('META_CAPI_ENABLED is false — skipping CAPI upload');
    return { skipped: 'disabled' };
  }
  if (!env.META_ACCESS_TOKEN) {
    log.warn('META_ACCESS_TOKEN missing — cannot upload to Meta CAPI');
    return { skipped: 'no_token' };
  }

  const opts = {
    datasetId: env.META_CAPI_DATASET_ID,
    token: env.META_ACCESS_TOKEN,
    version: env.META_GRAPH_VERSION,
    testEventCode: env.META_CAPI_TEST_EVENT_CODE,
  };

  const apps: CapiUploadResult['apps'] = [];

  for (const app of env.MIL_ENABLED_APPS) {
    const pending = await selectPending(app);
    let uploaded = 0;

    for (let i = 0; i < pending.length; i += BATCH) {
      const batch = pending.slice(i, i + BATCH);
      const events = batch.map((r) => buildPurchaseEvent(toRow(r)));
      const result = await sendEvents(events, opts);

      if (!result.ok) {
        log.error(
          { app, count: batch.length, error: result.error },
          'CAPI batch failed — leaving rows unmarked for next run',
        );
        break; // stop this app; unmarked rows retry next run
      }

      await db
        .update(conversion)
        .set({ capiUploadedAt: new Date() })
        .where(
          and(
            eq(conversion.app, app),
            inArray(
              conversion.orderId,
              batch.map((r) => r.order_id),
            ),
          ),
        );
      uploaded += batch.length;
      log.info(
        { app, count: batch.length, eventsReceived: result.eventsReceived },
        'CAPI batch uploaded',
      );
    }

    apps.push({ app, selected: pending.length, uploaded });
  }

  return { apps };
}

function toRow(r: PendingRow): ConversionRow {
  return {
    orderId: r.order_id,
    userId: r.user_id,
    valueInr: r.value_inr,
    occurredAt: r.occurred_at,
    actionSource: r.action_source,
    city: r.city,
    fbc: r.fbc,
    fbp: r.fbp,
  };
}

/**
 * Resolved purchases not yet uploaded, with the latest fbc/fbp attached
 * best-effort from attribution_touch (matched by session_id, else user_id).
 */
async function selectPending(app: AppKind): Promise<PendingRow[]> {
  const res = await db.execute(sql`
    select c.order_id, c.user_id, c.value_inr, c.occurred_at, c.action_source, c.city,
           t.fbc, t.fbp
    from marketing.conversion c
    left join lateral (
      select fbc, fbp
      from marketing.attribution_touch a
      where a.app = c.app
        and ( (c.session_id is not null and a.session_id = c.session_id)
           or (c.user_id is not null and a.user_id = c.user_id) )
        and (a.fbc is not null or a.fbp is not null)
      order by a.occurred_at desc
      limit 1
    ) t on true
    where c.app = ${app}
      and c.capi_uploaded_at is null
      and c.resolved_at is not null
    order by c.occurred_at
    limit ${MAX_PER_RUN}`);
  return res.rows as unknown as PendingRow[];
}
