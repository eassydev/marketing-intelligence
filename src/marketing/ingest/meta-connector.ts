import type { AppKind } from '../../shared/types/app.js';
import type {
  AdConnector,
  DateRange,
  NormalizedEntity,
  NormalizedPerfRow,
} from './connector.js';
import { assertInr } from './normalize.js';
import { createChildLogger } from '../../shared/logger/index.js';

const log = createChildLogger({ module: 'meta-connector' });

export interface MetaConfig {
  accessToken: string;
  adAccountId: string; // without the act_ prefix
  graphVersion: string; // e.g. v21.0 — confirm current version at integration time
}

interface MetaEntity {
  id: string;
  name?: string;
  effective_status?: string;
  daily_budget?: string; // minor units (paise) of account currency
  campaign_id?: string;
  adset_id?: string;
}

interface MetaInsightRow {
  ad_id?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  actions?: Array<{ action_type: string; value: string }>;
  action_values?: Array<{ action_type: string; value: string }>;
  date_start?: string;
}

const PURCHASE = new Set(['purchase', 'offsite_conversion.fb_pixel_purchase', 'omni_purchase']);

/**
 * Meta Marketing API Insights connector. Read-only (ads_read). Field set /
 * version must be confirmed against live docs when credentials are wired.
 */
export class MetaConnector implements AdConnector {
  readonly channel = 'meta' as const;
  private readonly base: string;

  constructor(private readonly config: MetaConfig) {
    this.base = `https://graph.facebook.com/${config.graphVersion}`;
  }

  async fetchEntities(_app: AppKind, _range: DateRange): Promise<NormalizedEntity[]> {
    await this.assertAccountInr();
    const out: NormalizedEntity[] = [];
    for (const level of ['campaign', 'adset', 'ad'] as const) {
      const edge = level === 'campaign' ? 'campaigns' : level === 'adset' ? 'adsets' : 'ads';
      const fields = 'id,name,effective_status,daily_budget,campaign_id,adset_id';
      const rows = await this.paged<MetaEntity>(
        `/act_${this.config.adAccountId}/${edge}?fields=${fields}`,
      );
      for (const r of rows) {
        out.push({
          channel: 'meta',
          level,
          externalId: r.id,
          parentExternalId: level === 'adset' ? r.campaign_id : level === 'ad' ? r.adset_id : undefined,
          name: r.name,
          status: r.effective_status,
          dailyBudgetInr: r.daily_budget ? Number(r.daily_budget) / 100 : undefined,
        });
      }
    }
    return out;
  }

  async fetchPerformance(_app: AppKind, range: DateRange): Promise<NormalizedPerfRow[]> {
    const fields = 'ad_id,spend,impressions,clicks,actions,action_values';
    const tr = encodeURIComponent(JSON.stringify({ since: range.since, until: range.until }));
    const rows = await this.paged<MetaInsightRow>(
      `/act_${this.config.adAccountId}/insights?level=ad&fields=${fields}&time_increment=1&time_range=${tr}`,
    );
    return rows
      .filter((r) => r.ad_id && r.date_start)
      .map((r) => ({
        channel: 'meta' as const,
        externalId: r.ad_id!,
        statDate: r.date_start!,
        spendInr: Number(r.spend ?? 0),
        impressions: Number(r.impressions ?? 0),
        clicks: Number(r.clicks ?? 0),
        conversions: sumActions(r.actions),
        convValueInr: sumActions(r.action_values),
      }));
  }

  private async assertAccountInr(): Promise<void> {
    const data = await this.get<{ currency?: string }>(
      `/act_${this.config.adAccountId}?fields=currency`,
    );
    assertInr('meta', data.currency);
  }

  private async paged<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let url: string | undefined = this.url(path);
    let guard = 0;
    while (url && guard++ < 100) {
      const page: { data?: T[]; paging?: { next?: string } } = await this.fetchJson(url);
      if (page.data) out.push(...page.data);
      url = page.paging?.next;
    }
    return out;
  }

  private async get<T>(path: string): Promise<T> {
    return this.fetchJson(this.url(path));
  }

  private url(path: string): string {
    const sep = path.includes('?') ? '&' : '?';
    return `${this.base}${path}${sep}access_token=${encodeURIComponent(this.config.accessToken)}&limit=500`;
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      log.error({ status: res.status, body: body.slice(0, 500) }, 'Meta API error');
      throw new Error(`Meta API ${res.status}`);
    }
    return (await res.json()) as T;
  }
}

function sumActions(actions: Array<{ action_type: string; value: string }> | undefined): number {
  if (!actions) return 0;
  return actions
    .filter((a) => PURCHASE.has(a.action_type))
    .reduce((sum, a) => sum + Number(a.value || 0), 0);
}
