import type { AppKind } from '../../shared/types/app.js';
import type { CacSummary } from '../serving/queries.js';

/** Compact GEO/AI-presence summary (Module A) for the LLM seam. */
export interface GeoSnapshot {
  window: { from: string; to: string };
  totalObservations: number;
  byEngine: Array<{
    engine: string;
    observations: number;
    mentions: number;
    mentionRate: number | null;
  }>;
}

export interface MarketingState {
  app: AppKind;
  window: { from: string; to: string };
  performance: { spendInr: number; firstOrders: number; blendedCacInr: number | null };
  topCampaigns: Array<{
    campaign: string | null;
    spendInr: number;
    firstOrders: number;
    costPerFirstOrderInr: number | null;
  }>;
  anomalies: unknown[]; // populated by Module B (alert layer) — empty now
  geoSnapshot: GeoSnapshot | null; // Module A summary; null until observations exist
}

export interface SerializeInput {
  app: AppKind;
  window: { from: string; to: string };
  cac: CacSummary;
  costPerFirstOrder: Array<Record<string, unknown>>;
  geo?: GeoSnapshot | null;
}

/**
 * LLM-readiness seam: render current marketing state into a compact, structured
 * payload an Anthropic-SDK call can reason over. Pure function — no model call
 * here. Both AI futures (GEO audit, autonomous decisioning) consume this shape.
 */
export function serializeMarketingState(input: SerializeInput): MarketingState {
  return {
    app: input.app,
    window: input.window,
    performance: {
      spendInr: input.cac.spend_inr,
      firstOrders: input.cac.first_orders,
      blendedCacInr: input.cac.blended_cac_inr,
    },
    topCampaigns: input.costPerFirstOrder.slice(0, 10).map((r) => ({
      campaign: (r.campaign as string | null) ?? null,
      spendInr: Number(r.spend_inr ?? 0),
      firstOrders: Number(r.first_orders ?? 0),
      costPerFirstOrderInr:
        r.cost_per_first_order_inr == null ? null : Number(r.cost_per_first_order_inr),
    })),
    anomalies: [],
    geoSnapshot: input.geo ?? null,
  };
}
