/**
 * Phase 7A4B — provider + config builder for the guarded live-model validation. The DEFAULT (no
 * `--confirm-live`) is the deterministic mock provider (offline, zero cost). A LIVE run requires the full
 * guard set; ANY missing guard throws (nonzero exit) and NEVER constructs a mock — explicit live intent must
 * never fall back to mock. Terra generates; Sol critiques (approved routing; production EMAIL_WRITER_MODEL /
 * EMAIL_REVIEWER_MODEL defaults are not touched).
 */

import { type Logger } from 'pino';
import { type AppConfig } from '../../../config/env.js';
import { MockLlmProvider } from '../../../integrations/llm/mock-llm.js';
import { OpenAiResponsesProvider } from '../../../integrations/llm/openai-responses.js';
import { PRICE_VERIFIED_AT, priceKnown } from '../../../integrations/llm/pricing.js';
import { type LlmProvider } from '../../../integrations/llm/provider.js';
import { defaultMockLiveValidationResponder } from '../../../fixtures/mock-live-validation-responses.js';
import { LIVE_FIXTURE_ID, type LiveOrchestratorConfig } from './live-orchestrator.js';

export class LiveGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveGuardError';
  }
}

export interface LiveGuardOptions {
  confirmLive: boolean;
  fixtureId: string;
  confirmNoRealProspect: boolean;
  maxLiveCalls: number;
}

export interface BuiltLiveProvider {
  provider: LlmProvider;
  mode: 'MOCK' | 'LIVE';
}

/** Build the live-validation config from env. Model routing uses the dedicated Phase 7A4B flags only. */
export function buildLiveValidationConfig(config: AppConfig): LiveOrchestratorConfig {
  return {
    terraModel: config.COMPETITOR_EMAIL_LIVE_VALIDATION_TERRA_MODEL,
    solModel: config.COMPETITOR_EMAIL_LIVE_VALIDATION_SOL_MODEL,
    terraEffort: config.COMPETITOR_EMAIL_LIVE_VALIDATION_TERRA_EFFORT,
    solEffort: config.COMPETITOR_EMAIL_LIVE_VALIDATION_SOL_EFFORT,
    store: config.LLM_STORE_RESPONSES,
    timeoutMs: config.COMPETITOR_EMAIL_LIVE_VALIDATION_TIMEOUT_MS,
    maxOutputTokens: config.COMPETITOR_EMAIL_LIVE_VALIDATION_MAX_OUTPUT_TOKENS,
    maxCostUsd: config.COMPETITOR_EMAIL_LIVE_VALIDATION_MAX_COST_USD,
    maxLiveCalls: 2,
  };
}

/**
 * Resolve the provider. Without `--confirm-live` -> deterministic mock (offline default). With
 * `--confirm-live` -> enforce EVERY guard and build the real OpenAI provider; on any missing guard THROW.
 */
export function buildLiveValidationProvider(config: AppConfig, logger: Logger, opts: LiveGuardOptions): BuiltLiveProvider {
  if (!opts.confirmLive) {
    return { provider: new MockLlmProvider(defaultMockLiveValidationResponder), mode: 'MOCK' };
  }

  // --- LIVE intent: every guard is mandatory; no mock fallback beyond this point. ---
  if (!config.COMPETITOR_EMAIL_LIVE_VALIDATION_ENABLED) throw new LiveGuardError('live run requires COMPETITOR_EMAIL_LIVE_VALIDATION_ENABLED=true');
  if (opts.fixtureId !== LIVE_FIXTURE_ID) throw new LiveGuardError(`live run requires --fixture ${LIVE_FIXTURE_ID} (fictional scenario)`);
  if (!opts.confirmNoRealProspect) throw new LiveGuardError('live run requires --confirm-no-real-prospect');
  if (opts.maxLiveCalls !== 2) throw new LiveGuardError('live run requires --max-live-calls 2 (exactly one Terra + one Sol)');
  if (config.LLM_PROVIDER !== 'openai') throw new LiveGuardError('live run requires LLM_PROVIDER=openai (no mock fallback under explicit live intent)');
  if (!config.ALLOW_PAID_LLM_CALLS) throw new LiveGuardError('live run requires ALLOW_PAID_LLM_CALLS=true (paid-call kill switch is off)');
  if (!config.OPENAI_API_KEY) throw new LiveGuardError('live run requires OPENAI_API_KEY');
  if (!PRICE_VERIFIED_AT) throw new LiveGuardError('LLM price table not verified; reconcile pricing.ts before any paid call');
  const terraModel = config.COMPETITOR_EMAIL_LIVE_VALIDATION_TERRA_MODEL;
  const solModel = config.COMPETITOR_EMAIL_LIVE_VALIDATION_SOL_MODEL;
  if (!priceKnown(terraModel)) throw new LiveGuardError(`no verified price for Terra model "${terraModel}"`);
  if (!priceKnown(solModel)) throw new LiveGuardError(`no verified price for Sol model "${solModel}"`);

  return { provider: new OpenAiResponsesProvider({ apiKey: config.OPENAI_API_KEY, logger }), mode: 'LIVE' };
}

/**
 * Phase 7A4B2 — provider builder for the guarded Sol-ONLY re-review. Identical fail-closed posture, but the
 * budget ceiling is EXACTLY ONE call (Sol only; the Terra base draft is reused from a saved artifact, so no
 * Terra call is made). Without `--confirm-live` -> deterministic mock (offline). With `--confirm-live` ->
 * enforce EVERY guard and build the real OpenAI provider; on any missing guard THROW (no mock fallback).
 * Only the Sol model price is required — no Terra call happens on this path.
 */
export function buildSolRereviewProvider(config: AppConfig, logger: Logger, opts: LiveGuardOptions): BuiltLiveProvider {
  if (!opts.confirmLive) {
    return { provider: new MockLlmProvider(defaultMockLiveValidationResponder), mode: 'MOCK' };
  }

  if (!config.COMPETITOR_EMAIL_LIVE_VALIDATION_ENABLED) throw new LiveGuardError('Sol-only re-review requires COMPETITOR_EMAIL_LIVE_VALIDATION_ENABLED=true');
  if (opts.fixtureId !== LIVE_FIXTURE_ID) throw new LiveGuardError(`Sol-only re-review requires --fixture ${LIVE_FIXTURE_ID} (fictional scenario)`);
  if (!opts.confirmNoRealProspect) throw new LiveGuardError('Sol-only re-review requires --confirm-no-real-prospect');
  if (opts.maxLiveCalls !== 1) throw new LiveGuardError('Sol-only re-review requires --max-live-calls 1 (exactly one Sol call; the Terra base draft is reused)');
  if (config.LLM_PROVIDER !== 'openai') throw new LiveGuardError('Sol-only re-review requires LLM_PROVIDER=openai (no mock fallback under explicit live intent)');
  if (!config.ALLOW_PAID_LLM_CALLS) throw new LiveGuardError('Sol-only re-review requires ALLOW_PAID_LLM_CALLS=true (paid-call kill switch is off)');
  if (!config.OPENAI_API_KEY) throw new LiveGuardError('Sol-only re-review requires OPENAI_API_KEY');
  if (!PRICE_VERIFIED_AT) throw new LiveGuardError('LLM price table not verified; reconcile pricing.ts before any paid call');
  const solModel = config.COMPETITOR_EMAIL_LIVE_VALIDATION_SOL_MODEL;
  if (!priceKnown(solModel)) throw new LiveGuardError(`no verified price for Sol model "${solModel}"`);

  return { provider: new OpenAiResponsesProvider({ apiKey: config.OPENAI_API_KEY, logger }), mode: 'LIVE' };
}
