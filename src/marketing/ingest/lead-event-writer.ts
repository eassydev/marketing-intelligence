import { db } from '../../shared/db/index.js';
import { leadEvent } from '../../shared/schema/index.js';
import type { LeadEventIngest } from './validators.js';

/**
 * Idempotent CTWA lead write. UNIQUE(app, ctwa_clid) + ON CONFLICT DO NOTHING
 * means a retried/duplicate qualification never double-counts (mirrors the
 * conversion writer). Returns whether the row was a dup.
 */
export async function writeLeadEvent(p: LeadEventIngest): Promise<{ deduped: boolean }> {
  const returned = await db
    .insert(leadEvent)
    .values({
      app: p.app,
      ctwaClid: p.ctwa_clid,
      waPhoneHash: p.wa_phone_hash ?? null,
      leadRef: p.lead_ref ?? null,
      occurredAt: p.occurred_at ? new Date(p.occurred_at) : new Date(),
    })
    .onConflictDoNothing({ target: [leadEvent.app, leadEvent.ctwaClid] })
    .returning({ id: leadEvent.id });

  return { deduped: returned.length === 0 };
}
