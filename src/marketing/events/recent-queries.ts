import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../shared/db/index.js';
import type { AppKind } from '../../shared/types/app.js';
import type { MonitorSource } from './validators.js';

/**
 * GET /marketing/events/recent — the newest N rows of one stream, normalized to
 * a single shape so the admin monitor renders every source with one component.
 *
 * PII policy: props are built by WHITELIST — click rows expose only
 * {link_id, is_bot, device} from `raw` (never ip_hash/user_agent or the rest of
 * the blob); touch rows expose utm fields + click-id PRESENCE booleans, never
 * the raw click ids; lead rows expose lead_ref only (never wa_phone_hash).
 */

export interface RecentEvent {
  source: MonitorSource;
  event_name: string | null;
  occurred_at: string; // ISO
  session_id: string | null;
  user_id: number | null;
  platform: string | null;
  props: Record<string, unknown> | null;
}

/** pg may hand back timestamptz as Date or string depending on the driver path. */
function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function baseRow(source: MonitorSource, row: Record<string, unknown>): RecentEvent {
  return {
    source,
    event_name: null,
    occurred_at: toIso(row.occurred_at),
    session_id: (row.session_id as string | null) ?? null,
    user_id: row.user_id == null ? null : Number(row.user_id),
    platform: null,
    props: null,
  };
}

export async function recentEvents(
  app: AppKind,
  source: MonitorSource,
  eventName: string | undefined,
  limit: number,
): Promise<RecentEvent[]> {
  const rows = await fetchRows(app, source, eventName, limit);
  return rows.map((row) => shapeRow(source, row));
}

async function fetchRows(
  app: AppKind,
  source: MonitorSource,
  eventName: string | undefined,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const queries: Record<MonitorSource, SQL> = {
    app: sql`
      select event_name, occurred_at, session_id, user_id, platform, props
      from marketing.app_event
      where app = ${app}${eventName ? sql` and event_name = ${eventName}` : sql``}
      order by occurred_at desc
      limit ${limit}`,
    click: sql`
      select occurred_at, session_id, user_id, raw
      from marketing.attribution_touch
      where app = ${app} and touch_type = 'first_party_click'
      order by occurred_at desc
      limit ${limit}`,
    lead: sql`
      select occurred_at, lead_ref, (capi_uploaded_at is not null) as capi_uploaded
      from marketing.lead_event
      where app = ${app}
      order by occurred_at desc
      limit ${limit}`,
    conversion: sql`
      select occurred_at, session_id, user_id, order_id, value_inr
      from marketing.conversion
      where app = ${app}
      order by occurred_at desc
      limit ${limit}`,
    touch: sql`
      select occurred_at, session_id, user_id, channel, utm_source, utm_campaign,
             (gclid is not null) as has_gclid,
             (fbclid is not null) as has_fbclid,
             (ctwa_clid is not null) as has_ctwa_clid
      from marketing.attribution_touch
      where app = ${app} and touch_type <> 'first_party_click'
      order by occurred_at desc
      limit ${limit}`,
  };
  const res = await db.execute(queries[source]);
  return res.rows as Array<Record<string, unknown>>;
}

function shapeRow(source: MonitorSource, row: Record<string, unknown>): RecentEvent {
  const out = baseRow(source, row);
  switch (source) {
    case 'app':
      out.event_name = row.event_name as string;
      out.platform = (row.platform as string | null) ?? null;
      out.props = (row.props as Record<string, unknown> | null) ?? null;
      break;
    case 'click': {
      // Whitelist from `raw` (written by BackendNew's /r/:slug click worker) —
      // never the whole blob, which may carry ip_hash/user_agent.
      const raw = (row.raw as Record<string, unknown> | null) ?? {};
      out.props = {
        link_id: raw.link_id ?? null,
        is_bot: raw.is_bot ?? null,
        device: raw.device ?? null,
      };
      break;
    }
    case 'lead':
      out.props = {
        lead_ref: (row.lead_ref as string | null) ?? null,
        capi_uploaded: Boolean(row.capi_uploaded),
      };
      break;
    case 'conversion':
      out.props = {
        order_id: row.order_id as string,
        value: Number(row.value_inr),
      };
      break;
    case 'touch':
      out.props = {
        utm_source: (row.utm_source as string | null) ?? null,
        utm_campaign: (row.utm_campaign as string | null) ?? null,
        channel: (row.channel as string | null) ?? null,
        has_gclid: Boolean(row.has_gclid),
        has_fbclid: Boolean(row.has_fbclid),
        has_ctwa_clid: Boolean(row.has_ctwa_clid),
      };
      break;
  }
  return out;
}
