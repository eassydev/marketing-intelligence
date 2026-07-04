import { z } from 'zod';
import { appSchema } from '../../shared/types/app.js';

const appField = appSchema;

/** POST /ingest/conversion — canonical numeric ids (BackendNew decrypts first). */
export const conversionIngestSchema = z.object({
  app: appField,
  order_id: z.string().min(1),
  user_id: z.number().int().positive().nullish(),
  value_inr: z.number().nonnegative(),
  is_first_order: z.boolean(),
  city: z.string().nullish(),
  category: z.string().nullish(),
  action_source: z.enum(['website', 'app', 'system_generated']).default('app'),
  occurred_at: z.string().datetime(),
  session_id: z.string().nullish(),
});
export type ConversionIngest = z.infer<typeof conversionIngestSchema>;

/** POST /ingest/touch — click-ids/utm captured at landing or forwarded server-side. */
export const touchIngestSchema = z.object({
  app: appField,
  session_id: z.string().min(1),
  user_id: z.number().int().positive().nullish(),
  occurred_at: z.string().datetime().optional(),
  gclid: z.string().nullish(),
  fbclid: z.string().nullish(),
  gbraid: z.string().nullish(),
  wbraid: z.string().nullish(),
  fbc: z.string().nullish(),
  fbp: z.string().nullish(),
  utm_source: z.string().nullish(),
  utm_medium: z.string().nullish(),
  utm_campaign: z.string().nullish(),
  utm_content: z.string().nullish(),
  utm_term: z.string().nullish(),
  landing_url: z.string().nullish(),
  referrer: z.string().nullish(),
  consent: z.boolean().default(false),
});
export type TouchIngest = z.infer<typeof touchIngestSchema>;

/** A single first-party product event (el_* taxonomy). */
export const appEventSchema = z.object({
  event_id: z.string().uuid(), // client-minted; idempotency key
  event_name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_]+$/, 'event_name must be lower snake_case (a-z, 0-9, _)'),
  occurred_at: z.string().datetime(),
  session_id: z.string().max(64).nullish(), // mil_sid
  user_id: z.number().int().positive().nullish(),
  platform: z.enum(['android', 'ios', 'web']).nullish(),
  app_version: z.string().max(32).nullish(),
  props: z.record(z.unknown()).nullish(),
});
export type AppEventInput = z.infer<typeof appEventSchema>;

/** POST /ingest/events — batch of product events from one app. */
export const eventsIngestSchema = z.object({
  app: appField,
  batch_id: z.string().uuid().optional(), // dedup/observability hint (not stored)
  events: z.array(appEventSchema).min(1).max(200),
});
export type EventsIngest = z.infer<typeof eventsIngestSchema>;
