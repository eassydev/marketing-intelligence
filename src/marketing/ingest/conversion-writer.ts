import { db } from '../../shared/db/index.js';
import { conversion, identityLink } from '../../shared/schema/index.js';
import type { ConversionIngest } from './validators.js';

/**
 * Idempotent conversion write. UNIQUE(app, order_id) + ON CONFLICT DO NOTHING
 * means retried webhooks never double-count. Returns whether the row was a dup.
 *
 * When the payload carries BOTH session_id and user_id, also upsert the
 * identity_link stitch (same discipline as touch-writer/event-writer) — a
 * booking may be the FIRST place that pairing appears, and without it the
 * funnel's identity join can't map the session's anonymous touches to the user.
 */
export async function writeConversion(
  p: ConversionIngest,
): Promise<{ deduped: boolean }> {
  const returned = await db
    .insert(conversion)
    .values({
      app: p.app,
      orderId: p.order_id,
      userId: p.user_id ?? null,
      occurredAt: new Date(p.occurred_at),
      valueInr: String(p.value_inr),
      isFirstOrder: p.is_first_order,
      city: p.city ?? null,
      category: p.category ?? null,
      actionSource: p.action_source,
      sessionId: p.session_id ?? null,
      ctwaClid: p.ctwa_clid ?? null,
      messagingChannel: p.messaging_channel ?? null,
    })
    .onConflictDoNothing({ target: [conversion.app, conversion.orderId] })
    .returning({ id: conversion.id });

  if (p.session_id && p.user_id != null) {
    await db
      .insert(identityLink)
      .values({ app: p.app, sessionId: p.session_id, userId: p.user_id })
      .onConflictDoNothing({
        target: [identityLink.app, identityLink.sessionId, identityLink.userId],
      });
  }

  return { deduped: returned.length === 0 };
}
