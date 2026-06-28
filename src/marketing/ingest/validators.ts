import { z } from 'zod';

const appField = z.enum(['services', 'society']).default('services');

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
