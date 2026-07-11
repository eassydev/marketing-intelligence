import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { makeServiceTokenGuard } from '../../shared/middleware/service-token.js';
import { envelope } from './envelope.js';
import {
  spendSummary,
  spendBreakdown,
  cacSummary,
  costPerFirstOrder,
  repeatRate,
  cohortRevenue,
  ltvCac,
  type SpendFilters,
  type Dimension,
} from './queries.js';
import { appSchema } from '../../shared/types/app.js';
import { dau, funnel, retention, type EventFilters } from './event-queries.js';
import { campaignFunnel, type CampaignFunnelFilters } from './campaign-funnel-queries.js';

const querySchema = z.object({
  app: appSchema,
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  city: z.string().optional(),
  category: z.string().optional(),
});

function parseFilters(req: FastifyRequest): SpendFilters {
  const q = querySchema.parse(req.query);
  const today = new Date();
  const ago = new Date(today);
  ago.setUTCDate(ago.getUTCDate() - 29);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return {
    app: q.app,
    from: q.from ?? fmt(ago),
    to: q.to ?? fmt(today),
    city: q.city,
    category: q.category,
  };
}

// ── Event-metric query parsing ──────────────────────────────────────────────
const eventQuerySchema = z.object({
  app: appSchema,
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

function parseEventFilters(req: FastifyRequest): EventFilters {
  const q = eventQuerySchema.parse(req.query);
  const today = new Date();
  const ago = new Date(today);
  ago.setUTCDate(ago.getUTCDate() - 29);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { app: q.app, from: q.from ?? fmt(ago), to: q.to ?? fmt(today) };
}

// ── Campaign-funnel query parsing ───────────────────────────────────────────
const campaignFunnelQuerySchema = z.object({
  app: appSchema,
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  utm_campaign: z.string().min(1).max(256).optional(),
  channel: z.enum(['google', 'meta', 'ctwa']).optional(),
  medium: z.string().min(1).max(256).optional(),
});

function parseCampaignFunnelFilters(req: FastifyRequest): CampaignFunnelFilters {
  const q = campaignFunnelQuerySchema.parse(req.query);
  const today = new Date();
  const ago = new Date(today);
  ago.setUTCDate(ago.getUTCDate() - 29);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return {
    app: q.app,
    from: q.from ?? fmt(ago),
    to: q.to ?? fmt(today),
    utmCampaign: q.utm_campaign,
    channel: q.channel,
    medium: q.medium,
  };
}

const EVENT_NAME_RE = /^[a-z0-9_]{1,64}$/;

/** Funnel steps: CSV of 2–6 event names, each el_* taxonomy-shaped. */
const stepsSchema = z
  .string()
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
  .pipe(z.array(z.string().regex(EVENT_NAME_RE)).min(2).max(6));

function parseSteps(req: FastifyRequest): string[] {
  const { steps } = z.object({ steps: z.string() }).parse(req.query);
  return stepsSchema.parse(steps);
}

const ALLOWED_RETENTION_DAYS = new Set([1, 3, 7, 14, 30, 60, 90]);

/** Retention day offsets: CSV ⊆ {1,3,7,14,30,60,90}, default 1,7,30. */
const daysSchema = z
  .string()
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean).map(Number))
  .pipe(
    z
      .array(z.number().int().refine((n) => ALLOWED_RETENTION_DAYS.has(n), 'day must be one of 1,3,7,14,30,60,90'))
      .min(1)
      .max(7),
  );

function parseDays(req: FastifyRequest): number[] {
  const { days } = z.object({ days: z.string().optional() }).parse(req.query);
  const parsed = days ? daysSchema.parse(days) : [1, 7, 30];
  return [...new Set(parsed)].sort((a, b) => a - b);
}

/** Retention cohort: 'first_seen' (default) or a specific el_* event name. */
const cohortSchema = z
  .string()
  .refine((s) => s === 'first_seen' || EVENT_NAME_RE.test(s), 'cohort must be first_seen or an event name');

function parseCohort(req: FastifyRequest): string {
  const { cohort } = z.object({ cohort: z.string().optional() }).parse(req.query);
  return cohort ? cohortSchema.parse(cohort) : 'first_seen';
}

/** Read-only serving API for Looker / dashboards. Guarded by MIL_SERVING_TOKEN. */
export async function servingRoutes(app: FastifyInstance): Promise<void> {
  const guard = makeServiceTokenGuard('serving', env.MIL_SERVING_TOKEN);
  app.addHook('preHandler', guard);

  app.get('/marketing/metrics/spend', async (req) => {
    const f = parseFilters(req);
    return envelope(f.app, { from: f.from, to: f.to }, f, await spendSummary(f));
  });

  const breakdown = (dimension: Dimension) => async (req: FastifyRequest) => {
    const f = parseFilters(req);
    return envelope(f.app, { from: f.from, to: f.to }, f, await spendBreakdown(f, dimension));
  };

  app.get('/marketing/metrics/spend-by-city', breakdown('city'));
  app.get('/marketing/metrics/spend-by-category', breakdown('category'));
  app.get('/marketing/metrics/spend-by-campaign', breakdown('campaign'));

  app.get('/marketing/metrics/cac', async (req) => {
    const f = parseFilters(req);
    return envelope(f.app, { from: f.from, to: f.to }, f, await cacSummary(f));
  });

  app.get('/marketing/metrics/cost-per-first-order', async (req) => {
    const f = parseFilters(req);
    return envelope(f.app, { from: f.from, to: f.to }, f, await costPerFirstOrder(f));
  });

  // ── First-party product-event metrics (app_event) ───────────────────────
  app.get('/marketing/metrics/dau', async (req) => {
    const f = parseEventFilters(req);
    return envelope(f.app, { from: f.from, to: f.to }, {}, await dau(f));
  });

  app.get('/marketing/metrics/funnel', async (req) => {
    const f = parseEventFilters(req);
    const steps = parseSteps(req);
    return envelope(f.app, { from: f.from, to: f.to }, {}, {
      steps: await funnel(f, steps),
    });
  });

  app.get('/marketing/metrics/retention', async (req) => {
    const f = parseEventFilters(req);
    const days = parseDays(req);
    const cohort = parseCohort(req);
    return envelope(f.app, { from: f.from, to: f.to }, {}, await retention(f, days, cohort));
  });

  // ── Campaign-attributed full funnel (Phase 6) ────────────────────────────
  // data = one row per utm_campaign (a single row when ?utm_campaign= given).
  app.get('/marketing/metrics/campaign-funnel', async (req) => {
    const f = parseCampaignFunnelFilters(req);
    return envelope(f.app, { from: f.from, to: f.to }, {}, await campaignFunnel(f));
  });

  // ── LTV:CAC + repeat-rate + cohort revenue (Phase F) ─────────────────────
  app.get('/marketing/metrics/ltv', async (req) => {
    const f = parseFilters(req);
    const [repeat, byChannel, cohorts] = await Promise.all([
      repeatRate(f),
      ltvCac(f),
      cohortRevenue(f),
    ]);
    return envelope(f.app, { from: f.from, to: f.to }, f, {
      repeat,
      by_channel: byChannel,
      cohorts,
    });
  });
}
