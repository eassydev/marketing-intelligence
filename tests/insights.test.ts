import { describe, it, expect } from 'vitest';
import { generateInsights } from '../src/marketing/insights/generate.js';
import type { MarketingState } from '../src/marketing/context/serialize.js';

const state: MarketingState = {
  app: 'services',
  window: { from: '2026-06-01', to: '2026-06-30' },
  performance: { spendInr: 3000, firstOrders: 2, blendedCacInr: 1500 },
  topCampaigns: [
    { campaign: 'mumbai_homecleaning_purchase', spendInr: 3000, firstOrders: 2, costPerFirstOrderInr: 1500 },
  ],
  anomalies: [],
  geoSnapshot: null,
};

describe('generateInsights', () => {
  it('returns a deterministic fallback when ANTHROPIC_API_KEY is unset', async () => {
    const r = await generateInsights(state);
    expect(r.generated).toBe(false);
    expect(r.model).toBeNull();
    expect(r.summary).toContain('blended CAC');
    expect(r.state).toBe(state);
  });
});
