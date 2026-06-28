import type { AppKind } from '../../shared/types/app.js';
import type {
  AdConnector,
  DateRange,
  NormalizedEntity,
  NormalizedPerfRow,
} from './connector.js';
import { microsToInr } from './normalize.js';
import { createChildLogger } from '../../shared/logger/index.js';

const log = createChildLogger({ module: 'google-connector' });

export interface GoogleConfig {
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  loginCustomerId: string; // MCC, digits only
  customerId: string; // digits only
  apiVersion: string; // e.g. v18 — confirm current version at integration time
}

interface GaqlRow {
  campaign?: { id?: string; name?: string; status?: string };
  adGroup?: { id?: string; name?: string };
  adGroupAd?: { ad?: { id?: string } };
  metrics?: {
    costMicros?: string;
    impressions?: string;
    clicks?: string;
    conversions?: number;
    conversionsValue?: number;
  };
  segments?: { date?: string };
}

/**
 * Google Ads API reporting connector via GAQL searchStream. Read-only
 * (auth/adwords). Version + resource fields must be confirmed against live docs
 * when credentials are wired.
 */
export class GoogleConnector implements AdConnector {
  readonly channel = 'google' as const;

  constructor(private readonly config: GoogleConfig) {}

  async fetchEntities(_app: AppKind, range: DateRange): Promise<NormalizedEntity[]> {
    // Entities are derived from the same report stream (campaign + ad group),
    // deduped — Google Ads has no cheap separate entity sweep we need here.
    const rows = await this.query(range);
    const seen = new Map<string, NormalizedEntity>();
    for (const r of rows) {
      const cId = r.campaign?.id;
      if (cId && !seen.has(`campaign:${cId}`)) {
        seen.set(`campaign:${cId}`, {
          channel: 'google',
          level: 'campaign',
          externalId: cId,
          name: r.campaign?.name,
          status: r.campaign?.status,
        });
      }
      const gId = r.adGroup?.id;
      if (gId && !seen.has(`adset:${gId}`)) {
        seen.set(`adset:${gId}`, {
          channel: 'google',
          level: 'adset',
          externalId: gId,
          parentExternalId: cId,
          name: r.adGroup?.name,
        });
      }
    }
    return [...seen.values()];
  }

  async fetchPerformance(_app: AppKind, range: DateRange): Promise<NormalizedPerfRow[]> {
    const rows = await this.query(range);
    return rows
      .filter((r) => r.campaign?.id && r.segments?.date)
      .map((r) => ({
        channel: 'google' as const,
        externalId: r.campaign!.id!, // performance attributed at campaign level
        statDate: r.segments!.date!,
        spendInr: microsToInr(r.metrics?.costMicros ?? 0),
        impressions: Number(r.metrics?.impressions ?? 0),
        clicks: Number(r.metrics?.clicks ?? 0),
        conversions: Number(r.metrics?.conversions ?? 0),
        convValueInr: Number(r.metrics?.conversionsValue ?? 0),
      }));
  }

  private async query(range: DateRange): Promise<GaqlRow[]> {
    const token = await this.accessToken();
    const gaql = `SELECT campaign.id, campaign.name, campaign.status, ad_group.id, ad_group.name, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value, segments.date FROM ad_group WHERE segments.date BETWEEN '${range.since}' AND '${range.until}'`;
    const res = await fetch(
      `https://googleads.googleapis.com/${this.config.apiVersion}/customers/${this.config.customerId}/googleAds:searchStream`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'developer-token': this.config.developerToken,
          'login-customer-id': this.config.loginCustomerId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: gaql }),
      },
    );
    if (!res.ok) {
      const body = await res.text();
      log.error({ status: res.status, body: body.slice(0, 500) }, 'Google Ads API error');
      throw new Error(`Google Ads API ${res.status}`);
    }
    // searchStream returns an array of { results: [...] } batches.
    const batches = (await res.json()) as Array<{ results?: GaqlRow[] }>;
    return batches.flatMap((b) => b.results ?? []);
  }

  private async accessToken(): Promise<string> {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: this.config.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) throw new Error(`Google OAuth ${res.status}`);
    const data = (await res.json()) as { access_token: string };
    return data.access_token;
  }
}
