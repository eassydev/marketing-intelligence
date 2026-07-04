import { z } from 'zod';

/**
 * Environment schema. Required keys fail fast at boot; parked-slice keys are
 * optional now and validated by their own slice when it ships. Keeping this in
 * one place means a misconfigured deploy dies immediately with every missing
 * key listed, not on first use deep in a job.
 */
const csv = (value: string): string[] =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export const envSchema = z
  .object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(5100),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // Core infra — required to boot.
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  INTERNAL_INGEST_TOKEN: z.string().min(16),
  MIL_SERVING_TOKEN: z.string().min(16),

  // Tenant model — the set of valid `app` values is per-instance. MIL clones for
  // a different marketplace by setting MIL_APP_LIST (see NEW_INSTANCE.md); every
  // app enum in the code and the DB CHECK(app IN …) lists follow from it.
  MIL_APP_LIST: z
    .string()
    .default('services,society')
    .transform(csv)
    .pipe(z.array(z.string().min(1)).nonempty()),
  // Optional; when unset they derive from MIL_APP_LIST (default app = first app,
  // enabled = [first app]). Both are validated ⊆ MIL_APP_LIST in the refine below.
  MIL_DEFAULT_APP: z.string().optional(),
  MIL_ENABLED_APPS: z.string().optional(),
  MIL_ACTION_MODE: z.enum(['dry_run', 'live']).default('dry_run'),
  MIL_CLICK_LOOKBACK_DAYS: z.coerce.number().int().positive().default(7),
  // app_event retention: partitions older than this many months are dropped by
  // the monthly events-maintain job. 13 keeps a rolling year + current month.
  MIL_EVENTS_RETENTION_MONTHS: z.coerce.number().int().positive().default(13),

  // Instance identity + localization (per-clone). MIL_QUEUE_PREFIX namespaces
  // every BullMQ queue so multiple instances can share one Redis safely.
  MIL_QUEUE_PREFIX: z.string().min(1).default('mil'),
  MIL_CURRENCY: z.string().min(1).default('INR'),
  MIL_CRON_TIMEZONE: z.string().min(1).default('Asia/Kolkata'),
  MIL_MARKET_DESCRIPTION: z.string().min(1).default('Indian home-services marketplace'),

  // Alert layer (Module B) thresholds.
  MIL_CPFO_ALERT_INR: z.coerce.number().nonnegative().default(500),
  MIL_DROP_ALERT_PCT: z.coerce.number().min(0).max(100).default(40),

  // LLM seam — optional until the AI brain ships.
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-haiku-4-5'),

  // GEO/AI-presence monitor (Module A). Engine keys are optional — an engine
  // without a key is simply skipped (mirrors the connector factory pattern).
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-2.0-flash'),
  PERPLEXITY_API_KEY: z.string().optional(),
  PERPLEXITY_MODEL: z.string().default('sonar'),
  MIL_BRAND_ALIASES: z
    .string()
    .default('eassylife,eassy life,eassy.life')
    .transform(csv)
    .pipe(z.array(z.string()).nonempty()),
  MIL_GEO_CITIES: z
    .string()
    .default('bangalore,mumbai,delhi,pune,hyderabad')
    .transform(csv)
    .pipe(z.array(z.string()).nonempty()),
  MIL_GEO_CATEGORIES: z
    .string()
    .default('home cleaning,plumbing,electrician,appliance repair,pest control')
    .transform(csv)
    .pipe(z.array(z.string()).nonempty()),
  // Hard cost cap: max engine questions generated per run (per engine).
  MIL_GEO_MAX_QUESTIONS: z.coerce.number().int().positive().default(40),

  // Parked-slice credentials — optional now; each slice validates its own at use.
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_ACCESS_TOKEN: z.string().optional(),
  META_AD_ACCOUNT_ID: z.string().optional(),
  META_GRAPH_VERSION: z.string().default('v21.0'),

  GOOGLE_ADS_DEVELOPER_TOKEN: z.string().optional(),
  GOOGLE_ADS_CLIENT_ID: z.string().optional(),
  GOOGLE_ADS_CLIENT_SECRET: z.string().optional(),
  GOOGLE_ADS_REFRESH_TOKEN: z.string().optional(),
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: z.string().optional(),
  GOOGLE_ADS_CUSTOMER_ID: z.string().optional(),
  GOOGLE_ADS_API_VERSION: z.string().default('v18'),

  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_TOKEN: z.string().optional(),
  WHATSAPP_API_VERSION: z.string().default('v21.0'),
  WHATSAPP_RECIPIENT_ALLOWLIST: z.string().default('').transform(csv),
  })
  // Fill app defaults from MIL_APP_LIST when unset, then normalize the enabled
  // list to an array.
  .transform((v) => ({
    ...v,
    MIL_DEFAULT_APP: v.MIL_DEFAULT_APP ?? v.MIL_APP_LIST[0],
    MIL_ENABLED_APPS: v.MIL_ENABLED_APPS ? csv(v.MIL_ENABLED_APPS) : [v.MIL_APP_LIST[0]],
  }))
  // Every app referenced by MIL_DEFAULT_APP / MIL_ENABLED_APPS must be declared
  // in MIL_APP_LIST — catches typos and stale config at boot, not deep in a job.
  .superRefine((v, ctx) => {
    const allowed = new Set(v.MIL_APP_LIST);
    if (!allowed.has(v.MIL_DEFAULT_APP)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MIL_DEFAULT_APP'],
        message: `'${v.MIL_DEFAULT_APP}' is not in MIL_APP_LIST [${v.MIL_APP_LIST.join(', ')}]`,
      });
    }
    for (const app of v.MIL_ENABLED_APPS) {
      if (!allowed.has(app)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MIL_ENABLED_APPS'],
          message: `'${app}' is not in MIL_APP_LIST [${v.MIL_APP_LIST.join(', ')}]`,
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Parse a raw environment object. Throws a single readable error listing every
 * invalid/missing key. Pure — tests call it with fixtures; boot calls it once.
 */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}

export const env: Env = parseEnv(process.env);
