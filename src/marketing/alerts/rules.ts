import type { AppKind } from '../../shared/types/app.js';

export type Severity = 'info' | 'warn' | 'critical';

export interface AlertProposal {
  ruleKey: string;
  severity: Severity;
  scope: Record<string, unknown>;
  metric: string;
  observed: number;
  threshold: number;
  message: string;
}

export interface CpfoRow {
  campaign?: string | null;
  city?: string | null;
  category?: string | null;
  cost_per_first_order_inr?: number | null;
}

export interface RuleInput {
  app: AppKind;
  costPerFirstOrder: CpfoRow[];
  firstOrdersToday: number;
  firstOrdersTrailingAvg: number;
  cpfoThresholdInr: number;
  dropThresholdPct: number;
}

/**
 * Pure guardrail rules over current marketing state. No IO — evaluate.ts feeds it
 * computed metrics and persists/notifies the proposals it returns.
 */
export function evaluateRules(input: RuleInput): AlertProposal[] {
  const out: AlertProposal[] = [];

  // Rule 1 — cost per first order above threshold for a campaign (needs spend).
  for (const r of input.costPerFirstOrder) {
    const cpfo = r.cost_per_first_order_inr;
    if (cpfo != null && cpfo > input.cpfoThresholdInr) {
      out.push({
        ruleKey: 'cpfo_high',
        severity: 'warn',
        scope: { campaign: r.campaign ?? null, city: r.city ?? null, category: r.category ?? null },
        metric: 'cost_per_first_order_inr',
        observed: cpfo,
        threshold: input.cpfoThresholdInr,
        message: `Cost per first order ₹${cpfo} exceeds ₹${input.cpfoThresholdInr} for ${r.campaign ?? 'unknown campaign'}`,
      });
    }
  }

  // Rule 2 — first-order volume drop vs trailing average (works without spend).
  if (input.firstOrdersTrailingAvg > 0) {
    const dropPct = (1 - input.firstOrdersToday / input.firstOrdersTrailingAvg) * 100;
    if (dropPct >= input.dropThresholdPct) {
      out.push({
        ruleKey: 'first_order_drop',
        severity: 'critical',
        scope: {},
        metric: 'first_orders_today',
        observed: input.firstOrdersToday,
        threshold: input.firstOrdersTrailingAvg,
        message: `First orders today (${input.firstOrdersToday}) down ${dropPct.toFixed(0)}% vs trailing avg (${input.firstOrdersTrailingAvg.toFixed(1)})`,
      });
    }
  }

  return out;
}
