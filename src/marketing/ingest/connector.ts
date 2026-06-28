import type { AppKind } from '../../shared/types/app.js';

export type Channel = 'meta' | 'google';
export type EntityLevel = 'campaign' | 'adset' | 'ad';

export interface DateRange {
  /** inclusive, YYYY-MM-DD (IST-anchored) */
  since: string;
  until: string;
}

export interface NormalizedEntity {
  channel: Channel;
  level: EntityLevel;
  externalId: string;
  parentExternalId?: string;
  name?: string;
  status?: string;
  dailyBudgetInr?: number;
  currency?: string; // asserted INR at ingest
}

export interface NormalizedPerfRow {
  channel: Channel;
  externalId: string; // entity external id this row belongs to
  statDate: string; // YYYY-MM-DD
  spendInr: number;
  impressions: number;
  clicks: number;
  conversions: number;
  convValueInr: number;
}

/**
 * One implementation per channel. A connector's only job is to pull and
 * normalize into the canonical shapes above — Meta/Google field differences are
 * reconciled here so nothing downstream cares which platform produced a number.
 */
export interface AdConnector {
  readonly channel: Channel;
  fetchEntities(app: AppKind, range: DateRange): Promise<NormalizedEntity[]>;
  fetchPerformance(app: AppKind, range: DateRange): Promise<NormalizedPerfRow[]>;
}
