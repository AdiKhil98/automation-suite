import { z } from 'zod';
import { EnvValidationError } from '../utils/errors.js';

/**
 * Strict environment schema. Validated once at startup via {@link loadConfig}.
 * No module reads process.env directly — everything flows through the typed config
 * this produces, so missing/invalid variables fail fast with a readable message.
 */

/** Parse an explicit "true"/"false" string into a boolean (no loose coercion). */
const boolString = (defaultValue: boolean) =>
  z
    .enum(['true', 'false'])
    .default(defaultValue ? 'true' : 'false')
    .transform((v) => v === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Global safety switches. Default-safe: dry-run on, outbound off.
  DRY_RUN: boolString(true),
  OUTBOUND_ACTIONS_ENABLED: boolString(false),

  // Cost & rate limits (used from later phases; validated here so config is complete).
  MAX_LEADS_PER_RUN: z.coerce.number().int().positive().default(50),
  MAX_ACCEPTED_LEADS_PER_RUN: z.coerce.number().int().positive().default(25),
  MAX_WEBSITE_AUDITS_PER_RUN: z.coerce.number().int().positive().default(25),
  MAX_COMPETITOR_RESEARCH_PER_RUN: z.coerce.number().int().nonnegative().default(5),
  MAX_BRANDED_DEMOS_PER_RUN: z.coerce.number().int().nonnegative().default(3),
  MAX_EMAIL_DRAFTS_PER_RUN: z.coerce.number().int().nonnegative().default(25),
  MAX_MODEL_COST_USD_PER_RUN: z.coerce.number().nonnegative().default(5),
  MAX_MODEL_COST_USD_PER_LEAD: z.coerce.number().nonnegative().default(0.5),

  // LLM provider config (abstraction-first; concrete provider chosen in Phase 5).
  LLM_PROVIDER: z.string().default('mock'),
  LLM_MODEL_RESEARCH: z.string().optional(),
  LLM_MODEL_AUDIT: z.string().optional(),
  LLM_MODEL_EMAIL_WRITER: z.string().optional(),
  LLM_MODEL_EMAIL_REVIEWER: z.string().optional(),

  // Lead source (mock by default; google_places is the explicit feature flag).
  LEAD_SOURCE: z.enum(['mock', 'google_places']).default('mock'),
  GOOGLE_PLACES_API_KEY: z.string().optional(),

  // Google Places / collection tuning.
  PLACES_PAGE_SIZE: z.coerce.number().int().min(1).max(20).default(20),
  PLACES_MAX_PAGES: z.coerce.number().int().positive().default(3),
  PLACES_RATE_LIMIT_RPS: z.coerce.number().positive().default(5),
  PLACES_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  PLACES_MAX_RETRIES: z.coerce.number().int().nonnegative().default(2),

  // Deduplication near-address threshold in metres (conservative).
  DEDUP_NEAR_ADDRESS_METERS: z.coerce.number().positive().default(40),

  // --- Phase 4: enrichment ---
  ENRICHMENT_CONTEXT_PROVIDER: z.enum(['facts', 'manual', 'google', 'mock']).default('facts'),
  ENRICHMENT_CANDIDATE_PROVIDER: z.enum(['mock', 'manual', 'search']).default('mock'),
  // Paid read-only research (e.g. Google Place Details). Separate from the outbound kill switch.
  ALLOW_PAID_READS: boolString(false),
  MAX_GOOGLE_CONTEXT_REQUESTS_PER_RUN: z.coerce.number().int().nonnegative().default(10),
  MAX_GOOGLE_CONTEXT_COST_USD_PER_RUN: z.coerce.number().nonnegative().default(1),
  MAX_ENRICHMENTS_PER_RUN: z.coerce.number().int().positive().default(25),
  ENRICHMENT_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6),
  ENRICHMENT_AMBIGUOUS_MARGIN: z.coerce.number().min(0).max(1).default(0.1),
  ENRICH_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  ENRICH_MAX_REDIRECTS: z.coerce.number().int().nonnegative().default(5),
  ENRICH_MAX_BYTES: z.coerce.number().int().positive().default(2_000_000),
  ENRICH_MAX_PAGES: z.coerce.number().int().positive().default(5),
});

const refinedEnvSchema = envSchema.superRefine((val, ctx) => {
  if (val.LEAD_SOURCE === 'google_places' && !val.GOOGLE_PLACES_API_KEY) {
    ctx.addIssue({
      code: 'custom',
      path: ['GOOGLE_PLACES_API_KEY'],
      message: 'GOOGLE_PLACES_API_KEY is required when LEAD_SOURCE=google_places',
    });
  }
  // Google context reads only occur when explicitly allowed; only then is a key required.
  if (val.ENRICHMENT_CONTEXT_PROVIDER === 'google' && val.ALLOW_PAID_READS && !val.GOOGLE_PLACES_API_KEY) {
    ctx.addIssue({
      code: 'custom',
      path: ['GOOGLE_PLACES_API_KEY'],
      message: 'GOOGLE_PLACES_API_KEY is required when ENRICHMENT_CONTEXT_PROVIDER=google and ALLOW_PAID_READS=true',
    });
  }
});

export type AppConfig = z.infer<typeof envSchema>;

/**
 * Validate an environment record (defaults to process.env) into a typed config.
 * Throws {@link EnvValidationError} with a readable summary on failure.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = refinedEnvSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new EnvValidationError(`Environment validation failed:\n${issues}`);
  }
  return result.data;
}
