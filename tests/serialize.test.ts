import { describe, it, expect } from 'vitest';
import { serializeMarketingState } from '../src/marketing/context/serialize.js';

describe('serializeMarketingState', () => {
  it('renders a compact, bounded structured state', () => {
    const state = serializeMarketingState({
      app: 'services',
      window: { from: '2026-06-01', to: '2026-06-30' },
      cac: { spend_inr: 3000, first_orders: 1, all_orders: 2, blended_cac_inr: 3000 },
      costPerFirstOrder: Array.from({ length: 15 }, (_, i) => ({
        campaign: `c${i}`,
        spend_inr: 100 + i,
        first_orders: 1,
        cost_per_first_order_inr: 100 + i,
      })),
    });

    expect(state.performance).toEqual({ spendInr: 3000, firstOrders: 1, blendedCacInr: 3000 });
    expect(state.topCampaigns).toHaveLength(10); // bounded to 10
    expect(state.topCampaigns[0]).toEqual({
      campaign: 'c0',
      spendInr: 100,
      firstOrders: 1,
      costPerFirstOrderInr: 100,
    });
    expect(state.anomalies).toEqual([]);
    expect(state.geoSnapshot).toBeNull();
  });

  it('handles null cost-per-first-order', () => {
    const state = serializeMarketingState({
      app: 'services',
      window: { from: '2026-06-01', to: '2026-06-30' },
      cac: { spend_inr: 0, first_orders: 0, all_orders: 0, blended_cac_inr: null },
      costPerFirstOrder: [{ campaign: 'x', spend_inr: 50, first_orders: 0, cost_per_first_order_inr: null }],
    });
    expect(state.topCampaigns[0]?.costPerFirstOrderInr).toBeNull();
    expect(state.performance.blendedCacInr).toBeNull();
  });
});
