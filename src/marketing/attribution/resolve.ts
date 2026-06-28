import { and, eq, gte, lte, isNull, desc } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { db } from '../../shared/db/index.js';
import { conversion, attributionTouch } from '../../shared/schema/index.js';
import type { AppKind } from '../../shared/types/app.js';
import { env } from '../../config/env.js';
import { createChildLogger } from '../../shared/logger/index.js';
import { mapTouchToEntity } from './map-touch-to-entity.js';

const log = createChildLogger({ module: 'resolver' });

type ConversionRow = typeof conversion.$inferSelect;
type TouchRow = typeof attributionTouch.$inferSelect;

/**
 * Last-touch within the lookback window. Priority: by user_id, else by
 * session_id. Deterministic tie-break: occurred_at, received_at, id (all desc).
 */
async function findLastTouch(app: AppKind, c: ConversionRow): Promise<TouchRow | null> {
  const lookbackMs = env.MIL_CLICK_LOOKBACK_DAYS * 86_400_000;
  const start = new Date(c.occurredAt.getTime() - lookbackMs);
  const pick = (cond: ReturnType<typeof eq>) =>
    db
      .select()
      .from(attributionTouch)
      .where(
        and(
          eq(attributionTouch.app, app),
          lte(attributionTouch.occurredAt, c.occurredAt),
          gte(attributionTouch.occurredAt, start),
          cond,
        ),
      )
      .orderBy(
        desc(attributionTouch.occurredAt),
        desc(attributionTouch.receivedAt),
        desc(attributionTouch.id),
      )
      .limit(1);

  if (c.userId != null) {
    const r = await pick(eq(attributionTouch.userId, c.userId));
    if (r[0]) return r[0];
  }
  if (c.sessionId) {
    const r = await pick(eq(attributionTouch.sessionId, c.sessionId));
    if (r[0]) return r[0];
  }
  return null;
}

export interface ResolveResult {
  pending: number;
  resolved: number;
  matched: number;
}

/**
 * Resolve unresolved conversions. Idempotent: the `resolved_at IS NULL` guard on
 * both the select and the update means a concurrent/retried run never
 * double-writes. Outcomes: matched | organic | no_touch.
 */
export async function runResolver(opts?: { limit?: number }): Promise<ResolveResult> {
  const pending = await db
    .select()
    .from(conversion)
    .where(isNull(conversion.resolvedAt))
    .limit(opts?.limit ?? 500);

  let resolved = 0;
  let matched = 0;
  for (const c of pending) {
    const touch = await findLastTouch(c.app as AppKind, c);
    let outcome: 'matched' | 'organic' | 'no_touch' = 'no_touch';
    let entityId: number | null = null;
    let channel: string | null = null;

    if (touch) {
      const mapped = await mapTouchToEntity(c.app as AppKind, touch);
      if (mapped) {
        outcome = 'matched';
        entityId = mapped.adEntityId;
        channel = mapped.channel;
        matched += 1;
      } else {
        outcome = 'organic';
      }
    }

    const updated = await db
      .update(conversion)
      .set({
        attributedEntityId: entityId,
        attributedChannel: channel,
        attributionModel: 'last_touch',
        attributionOutcome: outcome,
        resolvedAt: sql`now()`,
      })
      .where(and(eq(conversion.id, c.id), isNull(conversion.resolvedAt)))
      .returning({ id: conversion.id });
    if (updated.length) resolved += 1;
  }

  log.info({ pending: pending.length, resolved, matched }, 'resolver run');
  return { pending: pending.length, resolved, matched };
}
