import { sql } from 'drizzle-orm';
import {
  bigint,
  text,
  numeric,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  } from 'drizzle-orm/pg-core';
import { marketing, idCol, appCol, appCheck } from './_shared.js';
import { adEntity } from './ad-entity.js';

/**
 * First-party booking TRUTH. UNIQUE(app, order_id) is the idempotency key for
 * the conversion writer. The partial index on unresolved rows doubles as the
 * attribution resolver's work queue.
 */
export const conversion = marketing.table(
  'conversion',
  {
    id: idCol(),
    app: appCol(),
    orderId: text('order_id').notNull(), // canonical booking id or razorpay order id
    userId: bigint('user_id', { mode: 'number' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    valueInr: numeric('value_inr', { precision: 10, scale: 2 }).notNull(),
    isFirstOrder: boolean('is_first_order').notNull(),
    city: text('city'),
    category: text('category'),
    actionSource: text('action_source'), // website | app | system_generated
    sessionId: text('session_id'), // resolver hint forwarded at booking
    // Resolver-written:
    attributedChannel: text('attributed_channel'),
    attributedEntityId: bigint('attributed_entity_id', { mode: 'number' }).references(
      () => adEntity.id,
    ),
    attributionModel: text('attribution_model'), // 'last_touch' (default)
    attributionOutcome: text('attribution_outcome'), // matched | organic | no_touch
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    // Meta CAPI upload marker — set once the row is pushed to the /events API.
    capiUploadedAt: timestamp('capi_uploaded_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('uq_conversion_order').on(t.app, t.orderId),
    index('idx_conversion_unresolved')
      .on(t.app, t.receivedAt)
      .where(sql`resolved_at is null`),
    index('idx_conversion_user').on(t.app, t.userId),
    index('idx_conversion_entity')
      .on(t.app, t.attributedEntityId)
      .where(sql`attributed_entity_id is not null`),
    // CAPI job work queue: resolved purchases not yet uploaded to Meta.
    index('idx_conversion_capi_pending')
      .on(t.app, t.occurredAt)
      .where(sql`capi_uploaded_at is null and resolved_at is not null`),
    appCheck('conversion_app_chk', t.app),
  ],
);
