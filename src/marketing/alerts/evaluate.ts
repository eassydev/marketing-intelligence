import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../shared/db/index.js';
import { alert, adEntity } from '../../shared/schema/index.js';
import type { AppKind } from '../../shared/types/app.js';
import { env } from '../../config/env.js';
import { createChildLogger } from '../../shared/logger/index.js';
import { costPerFirstOrder } from '../serving/queries.js';
import { evaluateRules, type AlertProposal } from './rules.js';
import { WhatsAppNotifier } from '../../notifications/whatsapp-notifier.js';
import { actionPort } from '../actions/index.js';

const log = createChildLogger({ module: 'alerts' });
const notifier = new WhatsAppNotifier();

const fmt = (d: Date) => d.toISOString().slice(0, 10);

async function countFirstOrders(app: AppKind, from: string, to: string): Promise<number> {
  const res = await db.execute(sql`
    select count(*)::int as c from marketing.conversion
    where app = ${app} and is_first_order and occurred_at::date between ${from} and ${to}`);
  return Number((res.rows[0] as { c?: number } | undefined)?.c ?? 0);
}

/**
 * Module B — read-only on the spend side. Computes guardrail metrics, writes
 * breaches to marketing.alert (deduped per rule+message+day), notifies via the
 * in-house WhatsApp seam, and logs a dry-run proposed action through the action
 * port. It surfaces decisions to a human; it never touches live spend.
 */
export async function runAlertEvaluation(
  app: AppKind = 'services',
): Promise<{ proposals: number; fired: number }> {
  const today = new Date();
  const to = fmt(today);
  const from = fmt(new Date(today.getTime() - 29 * 86_400_000));
  const cpfo = (await costPerFirstOrder({ app, from, to })) as Array<Record<string, unknown>>;

  const firstOrdersToday = await countFirstOrders(app, to, to);
  const trailingStart = fmt(new Date(today.getTime() - 7 * 86_400_000));
  const yesterday = fmt(new Date(today.getTime() - 86_400_000));
  const firstOrdersTrailingAvg = (await countFirstOrders(app, trailingStart, yesterday)) / 7;

  const proposals = evaluateRules({
    app,
    costPerFirstOrder: cpfo.map((r) => ({
      campaign: (r.campaign as string | null) ?? null,
      city: (r.city as string | null) ?? null,
      category: (r.category as string | null) ?? null,
      cost_per_first_order_inr:
        r.cost_per_first_order_inr == null ? null : Number(r.cost_per_first_order_inr),
    })),
    firstOrdersToday,
    firstOrdersTrailingAvg,
    cpfoThresholdInr: env.MIL_CPFO_ALERT_INR,
    dropThresholdPct: env.MIL_DROP_ALERT_PCT,
  });

  let fired = 0;
  for (const p of proposals) {
    if (await alreadyFiredToday(app, p)) continue;
    await db.insert(alert).values({
      app,
      firedAt: sql`now()`,
      severity: p.severity,
      ruleKey: p.ruleKey,
      scope: p.scope,
      metric: p.metric,
      observed: String(p.observed),
      threshold: String(p.threshold),
      message: p.message,
    });
    fired += 1;
    await notify(p);
    await proposeAction(app, p);
  }
  log.info({ app, proposals: proposals.length, fired }, 'alert evaluation');
  return { proposals: proposals.length, fired };
}

async function alreadyFiredToday(app: AppKind, p: AlertProposal): Promise<boolean> {
  const res = await db.execute(sql`
    select 1 from marketing.alert
    where app = ${app} and rule_key = ${p.ruleKey} and message = ${p.message}
      and fired_at::date = current_date limit 1`);
  return res.rows.length > 0;
}

async function notify(p: AlertProposal): Promise<void> {
  for (const to of env.WHATSAPP_RECIPIENT_ALLOWLIST) {
    try {
      // sendText only delivers inside a 24h session window; production alerting
      // should use an approved template (sendTemplate).
      await notifier.sendText(to, `[MIL ${p.severity}] ${p.message}`);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'alert notify failed');
    }
  }
}

async function proposeAction(app: AppKind, p: AlertProposal): Promise<void> {
  if (p.ruleKey !== 'cpfo_high') return;
  const campaign = p.scope.campaign as string | null;
  if (!campaign) return;
  const [e] = await db
    .select({ channel: adEntity.channel, externalId: adEntity.externalId, level: adEntity.level })
    .from(adEntity)
    .where(and(eq(adEntity.app, app), eq(adEntity.name, campaign)))
    .limit(1);
  if (!e) return;
  await actionPort.pauseEntity(
    {
      app,
      channel: e.channel as 'meta' | 'google',
      level: e.level as 'campaign' | 'adset' | 'ad',
      externalId: e.externalId,
    },
    { source: 'rules', reason: p.message, correlationId: `alert:${p.ruleKey}:${campaign}`, stateSnapshot: p },
  );
}
