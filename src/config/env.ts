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
  // Test-only connection. Application commands never use this; destructive test
  // helpers additionally validate it as a loopback, clearly test-named database.
  TEST_DATABASE_URL: z.string().optional(),
  ALLOW_TEST_DATABASE_DESTRUCTIVE_ACTIONS: boolString(false),

  // Global safety switches. Default-safe: dry-run on, outbound off.
  DRY_RUN: boolString(true),
  OUTBOUND_ACTIONS_ENABLED: boolString(false),
  // Operator-controlled end-to-end validation recipient. It is never copied into
  // business facts and is only read when --controlled-test explicitly names it.
  TEST_RECIPIENT_EMAIL: z.string().email().optional(),

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

  // Bounded radius prospecting. Disabled by default; real reads also require ALLOW_PAID_READS.
  PROSPECT_DISCOVERY_ENABLED: boolString(false),
  PROSPECT_MAX_CANDIDATES_PER_RUN: z.coerce.number().int().min(1).max(20).default(5),
  PROSPECT_TARGET_QUALIFIED_PER_RUN: z.coerce.number().int().min(1).max(20).default(1),
  PROSPECT_MAX_PLACE_DETAILS_PER_RUN: z.coerce.number().int().min(1).max(20).default(5),
  PROSPECT_MAX_WEBSITE_VERIFICATIONS_PER_RUN: z.coerce.number().int().min(1).max(20).default(5),
  PROSPECT_RANK_PREFERENCE: z.enum(['POPULARITY', 'DISTANCE']).default('POPULARITY'),
  PROSPECT_CONTINUE_PIPELINE: boolString(false),

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

  // --- Phase 8: demo decision & generation (local only; no deploy) ---
  DEMO_GENERATION_ENABLED: boolString(true),
  // A demo builds when facts suffice AND (score >= this OR a demonstrable finding exists).
  // (MAX_BRANDED_DEMOS_PER_RUN is defined above with the other per-run caps.)
  MIN_OPPORTUNITY_FOR_DEMO: z.coerce.number().min(0).max(100).default(35),
  DEMO_OUTPUT_DIR: z.string().default('./demos'),
  // Local preview server port (preview-demo). Never bound to a public interface.
  DEMO_PREVIEW_PORT: z.coerce.number().int().positive().default(4599),

  // --- Phase 8B: AI Demo Composer (local only; no deploy) ---
  // Off by default: compose-demos is a distinct, opt-in AI path alongside deterministic
  // generate-demos. Mock provider by default (LLM_PROVIDER); zero paid calls in tests.
  DEMO_COMPOSER_ENABLED: boolString(false),
  DEMO_COMPOSER_MODEL: z.string().default('gpt-5.6-sol'),
  DEMO_COMPOSER_REVIEWER_MODEL: z.string().default('gpt-5.6-terra'),
  DEMO_COMPOSER_EFFORT: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  DEMO_COMPOSER_REVIEWER_EFFORT: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  DEMO_COMPOSER_MAX_CALLS_PER_DEMO: z.coerce.number().int().min(1).max(2).default(2),
  DEMO_COMPOSER_MAX_COST_USD_PER_DEMO: z.coerce.number().nonnegative().default(0.35),
  DEMO_COMPOSER_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(2_500),
  DEMO_COMPOSER_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  // No generator/reviewer retries for the first live smoke test.
  DEMO_COMPOSER_MAX_RETRIES: z.coerce.number().int().nonnegative().default(0),
  // Git-ignored diagnostics dir: every run's spec + reviewer verdict (no secrets/reasoning).
  COMPOSER_DEBUG_DIR: z.string().default('./.composer-debug'),

  // --- Demo Engine V2 Milestone 1: inert foundation only ---
  // V1 remains authoritative. Future V2 commands must require both gates.
  DEMO_ENGINE_VERSION: z.enum(['v1', 'v2']).default('v1'),
  DEMO_V2_ENABLED: boolString(false),
  DEMO_V2_CREATIVE_PROVIDER: z.enum(['mock', 'openai']).default('mock'),
  DEMO_V2_CREATIVE_MODEL: z.string().default('gpt-5.6-sol'),
  DEMO_V2_CREATIVE_EFFORT: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).default('high'),
  DEMO_V2_TRANSLATION_PROVIDER: z.enum(['mock', 'openai']).default('mock'),
  DEMO_V2_TRANSLATION_MODEL: z.string().default('gpt-5.6-terra'),
  DEMO_V2_TRANSLATION_EFFORT: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  DEMO_V2_VISUAL_REVIEW_PROVIDER: z.enum(['mock', 'openai']).default('mock'),
  DEMO_V2_VISUAL_REVIEW_MODEL: z.string().default('gpt-5.6-sol'),
  DEMO_V2_VISUAL_REVIEW_EFFORT: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).default('high'),
  DEMO_V2_MAX_RENDERED_VERSIONS: z.coerce.number().int().min(1).max(3).default(3),
  DEMO_V2_MAX_SCREENSHOT_REVIEW_CALLS: z.coerce.number().int().min(1).max(3).default(3),
  DEMO_V2_MAX_IMPLEMENTATION_REVISIONS: z.coerce.number().int().min(0).max(2).default(2),
  DEMO_V2_MAX_COST_USD_PER_DEMO: z.coerce.number().nonnegative().default(3),
  DEMO_V2_COMPONENT_REGISTRY_PATH: z.string().default('./design-library/component-registry.v1.json'),
  DEMO_V2_REFERENCE_LIBRARY_PATH: z.string().default('./design-library/reference-library.v1.json'),

  // --- Phase 9: cold email writer (local only; no sending, no Gmail, no deploy) ---
  EMAIL_GENERATION_ENABLED: boolString(false),
  EMAIL_WRITER_MODEL: z.string().default('gpt-5.6-sol'),
  EMAIL_REVIEWER_MODEL: z.string().default('gpt-5.6-terra'),
  EMAIL_WRITER_EFFORT: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  EMAIL_REVIEWER_EFFORT: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  EMAIL_MAX_CALLS_PER_LEAD: z.coerce.number().int().min(1).max(2).default(2),
  EMAIL_MAX_COST_USD_PER_LEAD: z.coerce.number().nonnegative().default(0.2),
  EMAIL_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(1_500),
  EMAIL_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  EMAIL_MAX_RETRIES: z.coerce.number().int().nonnegative().default(0),
  EMAIL_DEBUG_DIR: z.string().default('./.email-debug'),

  // --- Phase 10: local review dashboard (loopback only; no auth/deploy/send) ---
  REVIEW_DASHBOARD_ENABLED: boolString(false),
  REVIEW_DASHBOARD_PORT: z.coerce.number().int().positive().default(4600),

  // --- Phase 11: Netlify preview deployment (draft deploys only; opt-in) ---
  // The API origin is FIXED in the adapter (not configurable). Token is never logged/persisted.
  NETLIFY_DEPLOYMENT_ENABLED: boolString(false),
  NETLIFY_AUTH_TOKEN: z.string().optional(),
  NETLIFY_SITE_ID: z.string().optional(),
  NETLIFY_EXPECTED_HOSTNAME: z.string().optional(),
  NETLIFY_MAX_DEPLOYMENTS_PER_RUN: z.coerce.number().int().positive().default(5),
  NETLIFY_MAX_DEPLOYMENTS_PER_DAY: z.coerce.number().int().positive().default(10),
  NETLIFY_MIN_DEPLOY_INTERVAL_MS: z.coerce.number().int().nonnegative().default(60_000),
  NETLIFY_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(2_000_000),
  NETLIFY_MAX_UPLOAD_FILES: z.coerce.number().int().positive().default(10),
  NETLIFY_DEPLOY_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  NETLIFY_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
  NETLIFY_MAX_POLL_ATTEMPTS: z.coerce.number().int().positive().default(30),
  NETLIFY_STAGING_DIR: z.string().default('./.netlify-staging'),

  // --- Phase 12: Gmail draft creation (drafts only; opt-in; OAuth) ---
  // Fixed API/OAuth origins live in the adapters. Refresh token is stored in a git-ignored
  // 0600 credential file — NEVER in env, DB, logs, or git.
  GMAIL_DRAFTS_ENABLED: boolString(false),
  // Draft creation is a reversible preparation action, independently gated from
  // irreversible outbound sending. Sending still requires OUTBOUND_ACTIONS_ENABLED.
  GMAIL_DRAFT_ACTIONS_ENABLED: boolString(false),
  // Preferred: the downloaded Google Cloud OAuth client JSON (Desktop app → `installed` key).
  // Git-ignored; avoids putting the secret in .env. Falls back to the two vars below.
  GMAIL_OAUTH_CLIENT_FILE: z.string().default('./.gmail-oauth-client.json'),
  GMAIL_OAUTH_CLIENT_ID: z.string().optional(),
  GMAIL_OAUTH_CLIENT_SECRET: z.string().optional(),
  GMAIL_OAUTH_REDIRECT_URI: z.string().default('http://127.0.0.1:4700/oauth/callback'),
  GMAIL_OAUTH_CALLBACK_PORT: z.coerce.number().int().positive().default(4700),
  GMAIL_ACCOUNT_EMAIL: z.string().optional(),
  GMAIL_SENDER_NAME: z.string().optional(),
  GMAIL_CREDENTIALS_FILE: z.string().default('./.gmail-credentials.json'),
  GMAIL_MAX_DRAFTS_PER_RUN: z.coerce.number().int().positive().default(5),
  GMAIL_MAX_DRAFTS_PER_DAY: z.coerce.number().int().positive().default(20),
  GMAIL_MIN_DRAFT_INTERVAL_MS: z.coerce.number().int().nonnegative().default(2_000),
  GMAIL_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  // --- Phase 13: scheduling (records intended send times only; NEVER sends) ---
  // Off by default. Scheduling performs no external action, so it may run with
  // OUTBOUND_ACTIONS_ENABLED=false; Phase 14 sending still requires the sending gates.
  SCHEDULING_ENABLED: boolString(false),
  // Deterministic, CONFIGURABLE defaults (operator policy — not a universal best practice).
  // Recipient-local business window (hours, 0–23) in the recipient's verified IANA timezone.
  SCHEDULING_WINDOW_START_HOUR: z.coerce.number().int().min(0).max(23).default(9),
  SCHEDULING_WINDOW_END_HOUR: z.coerce.number().int().min(1).max(24).default(17),
  // Allowed weekdays as ISO numbers 1=Mon … 7=Sun (comma-separated). Default Mon–Fri.
  SCHEDULING_ALLOWED_WEEKDAYS: z.string().default('1,2,3,4,5'),
  // Minimum spacing between two scheduled sends (same account), and per-day cap.
  SCHEDULING_MIN_SPACING_MINUTES: z.coerce.number().int().positive().default(30),
  SCHEDULING_DAILY_CAP: z.coerce.number().int().positive().default(20),
  // Do not schedule before now + this many minutes; search at most this many days ahead.
  SCHEDULING_EARLIEST_OFFSET_MINUTES: z.coerce.number().int().nonnegative().default(60),
  SCHEDULING_HORIZON_DAYS: z.coerce.number().int().positive().default(14),
  SCHEDULING_RULES_VERSION: z.string().default('sched-rules-1'),

  // --- Phase 14: controlled sending of one existing scheduled Gmail draft ---
  // Default-safe: the mock provider is selected and live sending is disabled. A live command
  // additionally requires OUTBOUND_ACTIONS_ENABLED=true and DRY_RUN=false.
  SENDING_ENABLED: boolString(false),
  SENDING_PROVIDER: z.enum(['mock', 'http']).default('mock'),
  SENDING_POLICY_VERSION: z.string().default('send-policy-1'),
  SENDING_MAX_LATE_MINUTES: z.coerce.number().int().nonnegative().default(60),
  SENDING_CONFIRMATION_TTL_SECONDS: z.coerce.number().int().positive().default(120),
  // Phase 15 send-time account cap. Confirmed sends only; default intentionally conservative.
  SENDING_DAILY_CAP: z.coerce.number().int().positive().default(1),

  // --- Phase 3C-A: guarded read-only KU64 evidence export ---
  // Off by default. The export CLI ALSO requires --confirm-production-read and an
  // exact ku64.de domain binding. It performs SELECT-only reads and never writes,
  // renders, deploys, drafts, schedules, or sends.
  ALLOW_PRODUCTION_READ_EXPORT: boolString(false),

  // --- Phase 16: production safety hardening ---
  // A separate read-only Gmail preflight switch. It never authorizes sending and is off by default.
  GMAIL_SEND_PREFLIGHT_ENABLED: boolString(false),
  // Documented retention windows. Execution remains an explicit administrative procedure.
  RETENTION_LEAD_DAYS: z.coerce.number().int().positive().default(365),
  RETENTION_PROVIDER_ID_DAYS: z.coerce.number().int().positive().default(90),
  RETENTION_READINESS_DAYS: z.coerce.number().int().positive().default(365),
  RETENTION_AUDIT_DAYS: z.coerce.number().int().positive().default(730),

  // --- Phase 17A: outreach tracking & follow-up operations (tracking only; NEVER sends) ---
  // Master switch for the outreach tracking commands. Off by default. Even when on,
  // Phase 17A performs no send, no Gmail mutation, and no automatic follow-up.
  OUTREACH_TRACKING_ENABLED: boolString(false),
  // Read-only Gmail reply detection. Requires the read-only Gmail scope. Off by default.
  // Even when true, the live reader ALSO requires the CLI flag --confirm-gmail-read.
  GMAIL_REPLY_SYNC_ENABLED: boolString(false),
  // Phase 17A2: the read-only reply reader uses its OWN credential file (gmail.readonly scope),
  // entirely separate from the gmail.compose sending credential. Git-ignored, 0600. Populated by
  // the one-time `gmail-read-auth` command. NEVER shares a file or scope with the sending path.
  GMAIL_READ_CREDENTIALS_FILE: z.string().default('./.gmail-read-credentials.json'),
  // Google Sheet projection. Postgres stays authoritative; the Sheet is a read-only
  // operator view. Off by default; a real Sheet write ALSO requires an explicit --confirm.
  GOOGLE_SHEETS_SYNC_ENABLED: boolString(false),
  GOOGLE_SHEETS_PROVIDER: z.enum(['mock', 'http']).default('mock'),
  GOOGLE_SHEETS_SPREADSHEET_ID: z.string().optional(),
  // Phase 17A3: the Sheets writer's OWN OAuth credential file (spreadsheets scope), separate from
  // every Gmail credential. Git-ignored, 0600. Populated by the one-time `sheets-auth` command.
  GOOGLE_SHEETS_CREDENTIALS_FILE: z.string().default('./.google-sheets-credentials.json'),
  // Deterministic default follow-up sequence policy (operator policy; not universal).
  OUTREACH_FOLLOWUP_1_DELAY_DAYS: z.coerce.number().int().positive().default(3),
  OUTREACH_FOLLOWUP_2_DELAY_DAYS: z.coerce.number().int().positive().default(5),
  OUTREACH_FOLLOWUP_DUE_HOUR_LOCAL: z.coerce.number().int().min(0).max(23).default(9),

  // --- Phase 17B: controlled first-send smoke test (exactly ONE tracked send; heavily gated) ---
  // Master switch for the Phase 17B smoke-test send path. Off by default. Even when true, an
  // actual send ALSO requires the global sending gates (SENDING_ENABLED=true,
  // OUTBOUND_ACTIONS_ENABLED=true, DRY_RUN=false), SENDING_PROVIDER=http, the CLI confirmation
  // flag, an exact sender match, and an allowlisted recipient. It never enables bulk sending,
  // automatic follow-up sending, or reply classification.
  OUTREACH_SMOKE_TEST_ENABLED: boolString(false),
  // The ONE address the smoke test may send to (an operator-owned test inbox — never a real
  // prospect). No default: the send fails closed unless this is explicitly configured AND the
  // CLI --recipient AND the tracked record's contact all equal it exactly.
  OUTREACH_SMOKE_TEST_RECIPIENT: z.string().optional(),
  // Human-approval validity window (minutes). An approval older than this is expired and the
  // send is refused. The sender identity is GMAIL_ACCOUNT_EMAIL (the actual sending account);
  // the CLI --sender must match it exactly and the provider must verify to that same account.
  OUTREACH_APPROVAL_TTL_MINUTES: z.coerce.number().int().positive().max(1440).default(60),
});

const refinedEnvSchema = envSchema.superRefine((val, ctx) => {
  if (val.PROSPECT_TARGET_QUALIFIED_PER_RUN > val.PROSPECT_MAX_CANDIDATES_PER_RUN) {
    ctx.addIssue({ code: 'custom', path: ['PROSPECT_TARGET_QUALIFIED_PER_RUN'], message: 'prospect target cannot exceed candidate cap' });
  }
  if (val.PROSPECT_MAX_PLACE_DETAILS_PER_RUN > val.PROSPECT_MAX_CANDIDATES_PER_RUN || val.PROSPECT_MAX_WEBSITE_VERIFICATIONS_PER_RUN > val.PROSPECT_MAX_CANDIDATES_PER_RUN) {
    ctx.addIssue({ code: 'custom', path: ['PROSPECT_MAX_CANDIDATES_PER_RUN'], message: 'prospect external-call caps cannot exceed candidate cap' });
  }
  if (val.PROSPECT_DISCOVERY_ENABLED && val.ALLOW_PAID_READS && !val.GOOGLE_PLACES_API_KEY) {
    ctx.addIssue({ code: 'custom', path: ['GOOGLE_PLACES_API_KEY'], message: 'GOOGLE_PLACES_API_KEY is required for enabled prospect discovery' });
  }
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
  // A real Sheet write path needs a spreadsheet id; only required when both the
  // http provider is selected AND sheet sync is enabled.
  if (val.GOOGLE_SHEETS_SYNC_ENABLED && val.GOOGLE_SHEETS_PROVIDER === 'http' && !val.GOOGLE_SHEETS_SPREADSHEET_ID) {
    ctx.addIssue({
      code: 'custom',
      path: ['GOOGLE_SHEETS_SPREADSHEET_ID'],
      message: 'GOOGLE_SHEETS_SPREADSHEET_ID is required when GOOGLE_SHEETS_PROVIDER=http and GOOGLE_SHEETS_SYNC_ENABLED=true',
    });
  }
  if (val.DEMO_V2_ENABLED && val.DEMO_ENGINE_VERSION !== 'v2') {
    ctx.addIssue({
      code: 'custom',
      path: ['DEMO_ENGINE_VERSION'],
      message: 'DEMO_ENGINE_VERSION must be v2 when DEMO_V2_ENABLED=true',
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
