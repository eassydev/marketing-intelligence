import type { AppKind } from '../../shared/types/app.js';

export type AdPlatform = 'meta' | 'google';
export type ActionType = 'pause' | 'set_budget' | 'adjust_tcpa';

export interface AdEntityRef {
  app: AppKind;
  channel: AdPlatform;
  level: 'campaign' | 'adset' | 'ad';
  externalId: string;
}

/** Who/why is invoking the port — what makes one seam serve rules/LLM/human. */
export interface ActionContext {
  source: 'rules' | 'llm' | 'human';
  reason: string;
  correlationId?: string;
  stateSnapshot?: unknown;
}

export interface ActionResult {
  ok: boolean;
  decisionId?: number;
  mode: 'dry_run' | 'live';
  status: string;
  detail?: string;
}

/**
 * The hands the autonomy layer will use. DryRunAdActionPort logs; LiveAdActionPort
 * (parked) executes behind an approval gate. Same interface either way — going
 * live is a config flip, never a retrofit.
 */
export interface AdActionPort {
  readonly mode: 'dry_run' | 'live';
  pauseEntity(ref: AdEntityRef, ctx: ActionContext): Promise<ActionResult>;
  setDailyBudgetInr(ref: AdEntityRef, amountInr: number, ctx: ActionContext): Promise<ActionResult>;
  adjustTargetCpaInr(ref: AdEntityRef, amountInr: number, ctx: ActionContext): Promise<ActionResult>;
}
