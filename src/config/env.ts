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
