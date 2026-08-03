/**
 * Phase 7A4B — live-model validation orchestrator. ONE Terra base generation, deterministic enrichment via
 * the reused 7A4A harness (same Terra artifact for baseline AND enriched), then ONE advisory Sol critique.
 *
 * Fail-closed order: Terra malformed/invalid -> STOP before Sol. Deterministic hard-gate FAIL -> VALIDATION_
 * FAILED, Sol skipped (it cannot rescue safety). Live (real-provider) runs are pre-gated on a worst-case
 * cost projection; a null projection or over-budget projection blocks BEFORE any call. Never retries, never
 * falls back to mock, never makes a third call.
 */

import { type LlmProvider } from '../../../integrations/llm/provider.js';
import { worstCaseCostUsd } from '../../../integrations/llm/pricing.js';
import { worstCaseEmailInputTokens } from '../../../domain/email/email-token-budget.js';
import { solRatesEnrichedMateriallyWorse } from '../../../domain/email/sol-critique-schema.js';
import { runValidationHarness, type HarnessSuccess } from '../harness.js';
import { buildReport } from '../validation-report.js';
import { leadFacts, safeFindings, SCENARIO_LABEL } from '../../../fixtures/competitor-email-validation/synthetic-dental-scenario.js';
import { generateTerraBaseEmail, type TerraGenConfig } from './terra-base-generator.js';
import { buildSolCritiqueInput, runSolCritique, type SolCritiqueConfig } from './sol-critique-input.js';
import { buildLiveReport, type LiveSolResult, type LiveTerraResult, type LiveValidationReport } from './live-report.js';
import { LiveCallBudget } from './live-types.js';
import { type ReasoningEffort } from '../../../integrations/llm/provider.js';

export const LIVE_FIXTURE_ID = 'synthetic-dental';

export interface LiveOrchestratorConfig {
  terraModel: string;
  solModel: string;
  terraEffort: ReasoningEffort;
  solEffort: ReasoningEffort;
  store: boolean;
  timeoutMs: number;
  maxOutputTokens: number;
  maxCostUsd: number;
  maxLiveCalls: number;
}

export interface LiveOrchestratorDeps {
  provider: LlmProvider;
  config: LiveOrchestratorConfig;
  mode: 'MOCK' | 'LIVE';
  now?: () => Date;
  fixtureId?: string;
}

const SOL_NOT_RUN: LiveSolResult = { ran: false, malformed: false, reason: null, critique: null, materiallyWorse: null, call: null };

export async function runLiveValidation(deps: LiveOrchestratorDeps): Promise<LiveValidationReport> {
  const { provider, config } = deps;
  const now = deps.now ?? ((): Date => new Date());
  const fixtureId = deps.fixtureId ?? LIVE_FIXTURE_ID;
  const isReal = provider.name !== 'mock';

  const base = {
    fixtureId,
    scenarioLabel: SCENARIO_LABEL,
    mode: deps.mode,
    terraModel: config.terraModel,
    solModel: config.solModel,
    maxLiveCalls: config.maxLiveCalls,
  };

  // --- Pre-call cost gate (real provider only). A null or over-budget projection blocks before any call. ---
  if (isReal) {
    const inTok = worstCaseEmailInputTokens();
    const terraProj = worstCaseCostUsd(config.terraModel, inTok, config.maxOutputTokens);
    const solProj = worstCaseCostUsd(config.solModel, inTok, config.maxOutputTokens);
    if (terraProj === null || solProj === null || terraProj + solProj > config.maxCostUsd) {
      const terra: LiveTerraResult = {
        ok: false,
        reason: 'LIVE_BUDGET_BLOCKED',
        violations: [terraProj === null || solProj === null ? 'unverified price for a configured model' : `projected worst-case cost exceeds max ${String(config.maxCostUsd)}`],
        call: null,
      };
      return buildLiveReport({ ...base, now: now(), terra, deterministic: null, sol: SOL_NOT_RUN });
    }
  }

  const budget = new LiveCallBudget(config.maxLiveCalls);
  const terraCfg: TerraGenConfig = {
    model: config.terraModel, effort: config.terraEffort, store: config.store,
    timeoutMs: config.timeoutMs, maxOutputTokens: config.maxOutputTokens,
  };

  // --- Stage 1: single Terra base generation + prospect-only validation. ---
  const terraResult = await generateTerraBaseEmail({ provider, budget, config: terraCfg, facts: leadFacts, findings: safeFindings, now });
  if (!terraResult.ok) {
    const terra: LiveTerraResult = { ok: false, reason: terraResult.reason, violations: terraResult.violations, call: terraResult.call };
    return buildLiveReport({ ...base, now: now(), terra, deterministic: null, sol: SOL_NOT_RUN }); // STOP before Sol
  }
  const terra: LiveTerraResult = { ok: true, reason: null, violations: [], call: terraResult.call };

  // --- Stage 2: deterministic enrichment (SAME Terra artifact for baseline AND enriched). ---
  const outcome = await runValidationHarness(terraResult.draft);
  const deterministic = buildReport(outcome);

  // Deterministic FAIL (pipeline or hard-gate) -> VALIDATION_FAILED; Sol cannot rescue safety, so skip it.
  if (!outcome.ok || deterministic.result === 'FAIL') {
    return buildLiveReport({ ...base, now: now(), terra, deterministic, sol: SOL_NOT_RUN, terraBaseDraft: terraResult.draft });
  }

  // --- Stage 3: single Sol ADVISORY critique over sanitized, anonymized input. ---
  const solInput = buildSolCritiqueInput(outcome as HarnessSuccess, deterministic);
  const solCfg: SolCritiqueConfig = {
    model: config.solModel, effort: config.solEffort, store: config.store,
    timeoutMs: config.timeoutMs, maxOutputTokens: config.maxOutputTokens,
  };
  const solResult = await runSolCritique({
    provider, budget, config: solCfg, input: solInput,
    identityTokens: (outcome as HarnessSuccess).enrichmentPackage.identityTokens, now,
  });

  const sol: LiveSolResult = solResult.ok
    ? {
      ran: true, malformed: false, reason: null, critique: solResult.critique,
      materiallyWorse: solRatesEnrichedMateriallyWorse(solResult.critique), call: solResult.call,
    }
    : { ran: true, malformed: solResult.reason === 'SOL_MALFORMED_RESPONSE', reason: solResult.reason, critique: null, materiallyWorse: null, call: solResult.call };

  return buildLiveReport({ ...base, now: now(), terra, deterministic, sol, terraBaseDraft: terraResult.draft });
}
