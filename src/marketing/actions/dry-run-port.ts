import { db } from '../../shared/db/index.js';
import { decision } from '../../shared/schema/index.js';
import type {
  AdActionPort,
  AdEntityRef,
  ActionContext,
  ActionResult,
  ActionType,
} from './port.js';

/**
 * Records what an autonomous/rules/LLM caller WOULD do as a marketing.decision
 * row (mode='dry_run', status='proposed'). Performs NO live mutation — every
 * method funnels through `log`. This is the action-readiness seam.
 */
export class DryRunAdActionPort implements AdActionPort {
  readonly mode = 'dry_run' as const;

  pauseEntity(ref: AdEntityRef, ctx: ActionContext): Promise<ActionResult> {
    return this.log(ref, 'pause', {}, ctx);
  }

  setDailyBudgetInr(ref: AdEntityRef, amountInr: number, ctx: ActionContext): Promise<ActionResult> {
    return this.log(ref, 'set_budget', { amountInr }, ctx);
  }

  adjustTargetCpaInr(ref: AdEntityRef, amountInr: number, ctx: ActionContext): Promise<ActionResult> {
    return this.log(ref, 'adjust_tcpa', { amountInr }, ctx);
  }

  private async log(
    ref: AdEntityRef,
    actionType: ActionType,
    params: Record<string, unknown>,
    ctx: ActionContext,
  ): Promise<ActionResult> {
    const [row] = await db
      .insert(decision)
      .values({
        app: ref.app,
        source: ctx.source,
        channel: ref.channel,
        entityLevel: ref.level,
        externalId: ref.externalId,
        actionType,
        actionParams: params,
        stateSnapshot: ctx.stateSnapshot ?? null,
        mode: 'dry_run',
        status: 'proposed',
        reason: ctx.reason,
        correlationId: ctx.correlationId ?? null,
      })
      .returning({ id: decision.id });
    return { ok: true, decisionId: row!.id, mode: 'dry_run', status: 'proposed' };
  }
}
