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

  // --- Phase 5: website capture ---
  CAPTURE_PROVIDER: z.enum(['mock', 'playwright']).default('mock'),
  PLAYWRIGHT_BROWSER: z.enum(['chromium']).default('chromium'),
  CAPTURE_MAX_LEADS_PER_RUN: z.coerce.number().int().positive().default(10),
  CAPTURE_MAX_PAGES_PER_LEAD: z.coerce.number().int().positive().default(5),
  CAPTURE_MAX_CONCURRENCY: z.coerce.number().int().positive().default(2),
  CAPTURE_NAVIGATION_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  CAPTURE_TOTAL_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  CAPTURE_MAX_SCREENSHOT_BYTES: z.coerce.number().int().positive().default(5_000_000),
  CAPTURE_FULLPAGE_MAX_HEIGHT_PX: z.coerce.number().int().positive().default(20_000),
  CAPTURE_BLOCK_TRACKERS: boolString(true),
  CAPTURE_BLOCK_MEDIA: boolString(true),
  CAPTURE_ARTIFACT_DIR: z.string().default('./.artifacts'),
  // Test-only: allow loopback targets for the local Playwright fixture server.
  CAPTURE_ALLOW_LOOPBACK: boolString(false),
  // Chromium in-process sandbox. Default on (defense-in-depth). MUST be set false in
  // the maximally-hardened capture container (--cap-drop ALL + no-new-privileges make
  // the in-process sandbox unable to initialize; the container + egress firewall are
  // the authoritative boundary — see D-0022 / docs/deploy/hardened-browser.md).
  CAPTURE_CHROMIUM_SANDBOX: boolString(true),

  // --- Phase 6: AI website audit ---
  // LLM_PROVIDER (declared above) selects 'mock' (default, free) or 'openai'.
  OPENAI_API_KEY: z.string().optional(),
  // Separate paid-LLM kill switch: real OpenAI calls require BOTH LLM_PROVIDER=openai
  // AND this flag. Default off — tests and CI can never spend money.
  ALLOW_PAID_LLM_CALLS: boolString(false),
  LLM_MODEL_REVIEW: z.string().optional(),
  LLM_REASONING_EFFORT_AUDIT: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  LLM_REASONING_EFFORT_REVIEW: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  LLM_IMAGE_DETAIL: z.enum(['low', 'high', 'auto', 'original']).default('high'),
  LLM_STORE_RESPONSES: boolString(false),
  MAX_LLM_CALLS_PER_RUN: z.coerce.number().int().nonnegative().default(4),
  MAX_LLM_CALLS_PER_LEAD: z.coerce.number().int().nonnegative().default(4),
  // Attempts per stage. Gate A sets both to 1 (exactly one generator + one reviewer
  // call, NO repair/retry calls). Normal batch runs allow one bounded repair each.
  LLM_MAX_GENERATOR_ATTEMPTS: z.coerce.number().int().min(1).max(2).default(2),
  LLM_MAX_REVIEWER_ATTEMPTS: z.coerce.number().int().min(1).max(2).default(2),
  MAX_LLM_COST_USD_PER_RUN: z.coerce.number().nonnegative().default(2),
  MAX_LLM_COST_USD_PER_LEAD: z.coerce.number().nonnegative().default(0.5),
  MAX_LLM_INPUT_IMAGES_PER_CALL: z.coerce.number().int().nonnegative().default(2),
  MAX_LLM_EVIDENCE_ITEMS: z.coerce.number().int().positive().default(120),
  MAX_LLM_EVIDENCE_CHARS: z.coerce.number().int().positive().default(500),
  MAX_LLM_SECONDARY_PAGES: z.coerce.number().int().nonnegative().default(4),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  // SDK-level automatic retries. Default 0 — our "no retries" rule includes the SDK,
  // not only the audit-service attempt loop.
  LLM_MAX_RETRIES: z.coerce.number().int().nonnegative().default(0),
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(8_000),
  LLM_PROMPT_CACHE_ENABLED: boolString(true),
  AUDIT_ENVELOPE_DIR: z.string().default('./.audit-tmp'),
  AUDIT_DEBUG_DIR: z.string().default('./.audit-debug'),
  // Gate B eval matrix hard budgets. The runner projects each call's worst-case cost
  // before making it and stops when EITHER limit would be exceeded.
  MAX_EVAL_COST_USD: z.coerce.number().nonnegative().default(4),
  MAX_EVAL_CALLS: z.coerce.number().int().nonnegative().default(48),
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
  // Paid LLM calls need a key only when both switches are on.
  if (val.LLM_PROVIDER === 'openai' && val.ALLOW_PAID_LLM_CALLS && !val.OPENAI_API_KEY) {
    ctx.addIssue({
      code: 'custom',
      path: ['OPENAI_API_KEY'],
      message: 'OPENAI_API_KEY is required when LLM_PROVIDER=openai and ALLOW_PAID_LLM_CALLS=true',
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
