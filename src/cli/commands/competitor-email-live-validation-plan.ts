/**
 * Phase 7A4B — `competitor-email-live-validation-plan`: read-only. Prints the fixture, the configured Terra
 * and Sol model aliases, the hard two-call budget, the expected stages, and every guard a live run requires.
 * Performs NO model call, NO network, NO writes.
 */

import { type AppConfig } from '../../config/env.js';
import { LIVE_FIXTURE_ID } from '../../evaluation/email/live/live-orchestrator.js';
import { SOL_CRITIQUE_SCHEMA_NAME } from '../../domain/email/sol-critique-schema.js';

const STAGES: readonly string[] = [
  '0. guard check (flags + paid-call gate + explicit CLI confirmations; any gap exits nonzero)',
  '1. ONE Terra email_write call — prospect-only fictional brief (no competitor context)',
  '2. deterministic prospect-only validation of the Terra base (schema + validators + NONE mode)',
  '3. deterministic enrichment via the 7A4A harness (SAME Terra artifact for baseline AND enriched)',
  '4. 16 hard safety gates + 100-point rubric (safety overrides score)',
  '5. ONE Sol email_comparative_critique call — sanitized, anonymized, ADVISORY only',
  '6. combined operator status + local git-ignored report',
];

const GUARDS: readonly string[] = [
  'COMPETITOR_EMAIL_LIVE_VALIDATION_ENABLED=true',
  'LLM_PROVIDER=openai + ALLOW_PAID_LLM_CALLS=true + OPENAI_API_KEY',
  'verified price table (PRICE_VERIFIED_AT) + verified prices for both models',
  '--confirm-live',
  `--fixture ${LIVE_FIXTURE_ID} (fictional scenario)`,
  '--confirm-no-real-prospect',
  '--max-live-calls 2 (exactly one Terra + one Sol)',
];

export function competitorEmailLiveValidationPlanCommand(config: AppConfig): void {
  console.log('\n=== Phase 7A4B — Guarded Live-Model Email Validation — PLAN (read-only) ===');
  console.log(`fixture: ${LIVE_FIXTURE_ID} (SYNTHETIC, fictional dental clinic; no real prospect/website/person)`);
  console.log('\nRouting (dedicated 7A4B flags; production EMAIL_WRITER_MODEL / EMAIL_REVIEWER_MODEL unchanged):');
  console.log(`  Terra (${config.COMPETITOR_EMAIL_LIVE_VALIDATION_TERRA_MODEL}) — GENERATES the prospect-only base email (task email_write)`);
  console.log(`  Sol   (${config.COMPETITOR_EMAIL_LIVE_VALIDATION_SOL_MODEL}) — ADVISORY comparative critique (task email_review, schema ${SOL_CRITIQUE_SCHEMA_NAME})`);
  console.log('\nLive-call budget: at most ONE Terra + ONE Sol (hard ceiling 2). No retries, no fallback, no third call.');
  console.log(`Feature flag COMPETITOR_EMAIL_LIVE_VALIDATION_ENABLED currently: ${String(config.COMPETITOR_EMAIL_LIVE_VALIDATION_ENABLED)}`);

  console.log('\nStages:');
  for (const s of STAGES) console.log(`  ${s}`);

  console.log('\nA LIVE run requires ALL of (any missing guard exits nonzero; explicit live intent never falls back to mock):');
  for (const g of GUARDS) console.log(`  • ${g}`);

  console.log('\nArtifacts: .local-data/competitor-email-validation/live/ (git-ignored; 30-day / latest-5 retention).');
  console.log('Advisory only — this milestone never drafts, sends, writes the production DB, or makes a go-live decision.');
}
