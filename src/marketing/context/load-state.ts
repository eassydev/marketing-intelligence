import type { AppKind } from '../../shared/types/app.js';
import { cacSummary, costPerFirstOrder } from '../serving/queries.js';
import { mentionRateByEngine } from '../geo/queries.js';
import { serializeMarketingState, type GeoSnapshot, type MarketingState } from './serialize.js';

/**
 * GEO snapshot for the LLM seam: one cheap grouped query over the same window;
 * deterministic (ordered by engine). Null when no observations exist yet, so
 * pre-Module-A behaviour (geoSnapshot: null) is unchanged.
 */
async function loadGeoSnapshot(
  app: AppKind,
  from: string,
  to: string,
): Promise<GeoSnapshot | null> {
  const rows = await mentionRateByEngine({ app, from, to });
  if (rows.length === 0) return null;
  return {
    window: { from, to },
    totalObservations: rows.reduce((sum, r) => sum + Number(r.observations), 0),
    byEngine: rows.map((r) => ({
      engine: r.dimension,
      observations: Number(r.observations),
      mentions: Number(r.mentions),
      mentionRate: r.mention_rate == null ? null : Number(r.mention_rate),
    })),
  };
}

/** Load + serialize current marketing state for the LLM seam (IO wrapper). */
export async function loadMarketingState(
  app: AppKind,
  from: string,
  to: string,
): Promise<MarketingState> {
  const cac = await cacSummary({ app, from, to });
  const costPerFirstOrderRows = await costPerFirstOrder({ app, from, to });
  const geo = await loadGeoSnapshot(app, from, to);
  return serializeMarketingState({
    app,
    window: { from, to },
    cac,
    costPerFirstOrder: costPerFirstOrderRows,
    geo,
  });
}
