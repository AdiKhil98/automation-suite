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

  // Lead source (mock by default until credentials configured in Phase 2).
  LEAD_SOURCE: z.string().default('mock'),
});

export type AppConfig = z.infer<typeof envSchema>;

/**
 * Validate an environment record (defaults to process.env) into a typed config.
 * Throws {@link EnvValidationError} with a readable summary on failure.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new EnvValidationError(`Environment validation failed:\n${issues}`);
  }
  return result.data;
}
