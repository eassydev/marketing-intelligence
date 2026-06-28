import type { AppKind } from '../../shared/types/app.js';
import { cacSummary, costPerFirstOrder } from '../serving/queries.js';
import { serializeMarketingState, type MarketingState } from './serialize.js';

/** Load + serialize current marketing state for the LLM seam (IO wrapper). */
export async function loadMarketingState(
  app: AppKind,
  from: string,
  to: string,
): Promise<MarketingState> {
  const cac = await cacSummary({ app, from, to });
  const costPerFirstOrderRows = await costPerFirstOrder({ app, from, to });
  return serializeMarketingState({ app, window: { from, to }, cac, costPerFirstOrder: costPerFirstOrderRows });
}
