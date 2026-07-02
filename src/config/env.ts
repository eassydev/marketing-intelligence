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

export const envSchema = z.object({
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

  // Behaviour flags.
  MIL_DEFAULT_APP: z.enum(['services', 'society']).default('services'),
  MIL_ACTION_MODE: z.enum(['dry_run', 'live']).default('dry_run'),
  MIL_ENABLED_APPS: z
    .string()
    .default('services')
    .transform(csv)
    .pipe(z.array(z.enum(['services', 'society'])).nonempty()),
  MIL_CLICK_LOOKBACK_DAYS: z.coerce.number().int().positive().default(7),

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

  // Meta Conversions API (Phase F) — server-side Purchase upload. Dark by
  // default; reuses META_ACCESS_TOKEN (system user) + META_GRAPH_VERSION.
  META_CAPI_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  META_CAPI_DATASET_ID: z.string().default('1717873222070120'), // existing pixel id
  META_CAPI_TEST_EVENT_CODE: z.string().optional(), // Meta "Test Events" mode

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
