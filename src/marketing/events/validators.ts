import { z } from 'zod';
import { appSchema } from '../../shared/types/app.js';

/**
 * Zod validators for the events monitor: registry CRUD bodies plus the
 * overview/recent query strings. Kept apart from the route handlers (like
 * ingest/validators.ts) so unit tests can import them without touching the DB.
 */

/** Every registrable stream. MIL aggregates app/click/lead/conversion/touch;
 * 'notification' and 'web' register here too but are counted by BackendNew's
 * engagement overview (MySQL notifications ledger). */
export const REGISTRY_SOURCES = [
  'app',
  'click',
  'lead',
  'conversion',
  'touch',
  'notification',
  'web',
] as const;
export type RegistrySource = (typeof REGISTRY_SOURCES)[number];

/** The streams MIL itself serves in /marketing/events/overview + /recent. */
export const MONITOR_SOURCES = ['app', 'click', 'lead', 'conversion', 'touch'] as const;
export type MonitorSource = (typeof MONITOR_SOURCES)[number];

export const EXPECTED_FREQUENCIES = ['none', 'hourly', 'daily', 'weekly'] as const;
export type ExpectedFrequency = (typeof EXPECTED_FREQUENCIES)[number];

/** '' (empty) = whole-stream registry row; otherwise el_* taxonomy shape. */
const REGISTRY_EVENT_NAME_RE = /^[a-z0-9_]{0,64}$/;
/** A concrete event name for the /recent filter — empty makes no sense there. */
const EVENT_NAME_RE = /^[a-z0-9_]{1,64}$/;

export const registryListQuery = z.object({ app: appSchema });

export const registryCreateSchema = z.object({
  app: appSchema,
  source: z.enum(REGISTRY_SOURCES),
  event_name: z
    .string()
    .regex(REGISTRY_EVENT_NAME_RE, 'event_name must be lower snake_case (a-z, 0-9, _), max 64 chars')
    .default(''),
  description: z.string().max(500).nullish(),
  expected_frequency: z.enum(EXPECTED_FREQUENCIES).default('none'),
  is_active: z.boolean().default(true),
});
export type RegistryCreate = z.infer<typeof registryCreateSchema>;

/** PUT is partial; (app, source) are the row's identity and stay immutable. */
export const registryUpdateSchema = z.object({
  event_name: z
    .string()
    .regex(REGISTRY_EVENT_NAME_RE, 'event_name must be lower snake_case (a-z, 0-9, _), max 64 chars')
    .optional(),
  description: z.string().max(500).nullable().optional(),
  expected_frequency: z.enum(EXPECTED_FREQUENCIES).optional(),
  is_active: z.boolean().optional(),
});
export type RegistryUpdate = z.infer<typeof registryUpdateSchema>;

export const overviewQuery = z.object({ app: appSchema });

export const recentQuery = z.object({
  app: appSchema,
  source: z.enum(MONITOR_SOURCES),
  event_name: z
    .string()
    .regex(EVENT_NAME_RE, 'event_name must be lower snake_case (a-z, 0-9, _), max 64 chars')
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type RecentQuery = z.infer<typeof recentQuery>;
