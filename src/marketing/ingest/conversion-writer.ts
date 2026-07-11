import { db } from '../../shared/db/index.js';
import { conversion } from '../../shared/schema/index.js';
import type { ConversionIngest } from './validators.js';

/**
 * Idempotent conversion write. UNIQUE(app, order_id) + ON CONFLICT DO NOTHING
 * means retried webhooks never double-count. Returns whether the row was a dup.
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

  return { deduped: returned.length === 0 };
}
