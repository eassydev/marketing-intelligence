import { describe, it, expect } from 'vitest';
import { evaluateRules } from '../src/marketing/alerts/rules.js';

const base = {
  app: 'services' as const,
  cpfoThresholdInr: 500,
  dropThresholdPct: 40,
};

describe('evaluateRules', () => {
  it('fires cpfo_high when cost per first order exceeds threshold', () => {
    const out = evaluateRules({
      ...base,
      costPerFirstOrder: [
        { campaign: 'c1', cost_per_first_order_inr: 800 },
        { campaign: 'c2', cost_per_first_order_inr: 200 },
      ],
      firstOrdersToday: 5,
      firstOrdersTrailingAvg: 5,
    });
    const hit = out.find((a) => a.ruleKey === 'cpfo_high');
    expect(hit).toBeDefined();
    expect(hit?.scope.campaign).toBe('c1');
    expect(hit?.observed).toBe(800);
  });

  it('fires first_order_drop on a steep decline', () => {
    const out = evaluateRules({
      ...base,
      costPerFirstOrder: [],
      firstOrdersToday: 3,
      firstOrdersTrailingAvg: 10,
    });
    expect(out.map((a) => a.ruleKey)).toEqual(['first_order_drop']);
    expect(out[0]?.severity).toBe('critical');
  });

  it('stays quiet when healthy', () => {
    const out = evaluateRules({
      ...base,
      costPerFirstOrder: [{ campaign: 'c1', cost_per_first_order_inr: 100 }],
      firstOrdersToday: 10,
      firstOrdersTrailingAvg: 10,
    });
    expect(out).toEqual([]);
  });
});
