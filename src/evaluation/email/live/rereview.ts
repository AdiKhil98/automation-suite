/**
 * Phase 7A4B2 — guarded Sol-ONLY re-review orchestrator. Reuses the EXACT saved Terra base draft from a valid
 * full source artifact (NO Terra call), recomposes the enriched email with the CURRENT deterministic
 * templates, requires a deterministic PASS BEFORE Sol, then makes EXACTLY ONE advisory Sol call over
 * sanitized, anonymized fictional input. It never retries, never falls back, and never modifies either email
 * after Sol responds. The new report links back to the source report by hash.
 *
 * Fail-closed order: invalid/incomplete source artifact -> throw before any call. Missing Terra base draft ->
 * throw. Deterministic result not PASS -> return WITHOUT calling Sol. Real-provider cost over budget -> block
 * before the call. The single Sol call is hard-capped by a `LiveCallBudget(1)`.
 */

import { type LlmProvider } from '../../../integrations/llm/provider.js';
import { worstCaseCostUsd } from '../../../integrations/llm/pricing.js';
import { worstCaseEmailInputTokens } from '../../../domain/email/email-token-budget.js';
import { solRatesEnrichedMateriallyWorse } from '../../../domain/email/sol-critique-schema.js';
import { runValidationHarness, type HarnessSuccess } from '../harness.js';
import { buildReport, hashReport } from '../validation-report.js';
import { SCENARIO_LABEL } from '../../../fixtures/competitor-email-validation/synthetic-dental-scenario.js';
import { buildSolCritiqueInput, runSolCritique, type SolCritiqueConfig } from './sol-critique-input.js';
import { buildLiveReport, hashLiveReport, type LiveSolResult, type LiveTerraResult, type LiveValidationReport } from './live-report.js';
import { LiveCallBudget } from './live-types.js';
import { LIVE_FIXTURE_ID, type LiveOrchestratorConfig } from './live-orchestrator.js';

export class RereviewSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RereviewSourceError';
  }
}

export interface RereviewDeps {
  provider: LlmProvider;
  config: LiveOrchestratorConfig;
  mode: 'MOCK' | 'LIVE';
  source: LiveValidationReport;
  now?: () => Date;
  fixtureId?: string;
}

const SOL_NOT_RUN: LiveSolResult = { ran: false, malformed: false, reason: null, critique: null, materiallyWorse: null, call: null };
const REUSED_TERRA: LiveTerraResult = { ok: true, reason: null, violations: [], call: null };

/**
 * Verify the source artifact is a VALID full live report and return its Terra base draft. Throws
 * `RereviewSourceError` on any integrity failure (altered report, altered deterministic block, no enriched
 * artifact, or missing sanitized Terra base draft) BEFORE any provider call.
 */
export function requireValidFullSource(source: LiveValidationReport): NonNullable<LiveValidationReport['terraBaseDraft']> {
  if (hashLiveReport(source) !== source.reportHash) {
    throw new RereviewSourceError('source report hash mismatch — the saved artifact was altered or is incomplete');
  }
  const det = source.deterministic;
  if (!det) throw new RereviewSourceError('source report has no deterministic artifact (Terra base failed); nothing to re-review');
  if (hashReport(det) !== det.determinismHash) {
    throw new RereviewSourceError('source deterministic-block determinism-hash mismatch — the deterministic block was altered');
  }
  if (!source.terraBaseDraft) {
    throw new RereviewSourceError('source report carries no sanitized Terra base draft; a Sol-only re-review requires the exact saved base');
  }
  return source.terraBaseDraft;
}

export async function runSolOnlyRereview(deps: RereviewDeps): Promise<LiveValidationReport> {
  const { provider, config, source } = deps;
  const now = deps.now ?? ((): Date => new Date());
  const fixtureId = deps.fixtureId ?? LIVE_FIXTURE_ID;
  const isReal = provider.name !== 'mock';

  // --- Require a valid full source artifact and reuse its EXACT Terra base draft (no Terra call). ---
  const terraBaseDraft = requireValidFullSource(source);

  const base = {
    fixtureId,
    scenarioLabel: SCENARIO_LABEL,
    mode: deps.mode,
    terraModel: config.terraModel,
    solModel: config.solModel,
    maxLiveCalls: 1,
    sourceReportHash: source.reportHash,
  };

  // --- Deterministic recomposition with the CURRENT templates (offline; no model call). ---
  const outcome = await runValidationHarness(terraBaseDraft);
  const deterministic = buildReport(outcome);

  // --- Require deterministic PASS BEFORE Sol. A non-PASS result returns WITHOUT spending the Sol call. ---
  if (!outcome.ok || deterministic.result !== 'PASS') {
    return buildLiveReport({ ...base, now: now(), terra: REUSED_TERRA, deterministic, sol: SOL_NOT_RUN, terraBaseDraft });
  }

  // --- Pre-call cost gate (real provider only): a null or over-budget Sol projection blocks before the call. ---
  if (isReal) {
    const solProj = worstCaseCostUsd(config.solModel, worstCaseEmailInputTokens(), config.maxOutputTokens);
    if (solProj === null || solProj > config.maxCostUsd) {
      const terra: LiveTerraResult = {
        ok: true,
        reason: 'SOL_REREVIEW_BUDGET_BLOCKED',
        violations: [solProj === null ? 'unverified price for the Sol model' : `projected worst-case Sol cost exceeds max ${String(config.maxCostUsd)}`],
        call: null,
      };
      return buildLiveReport({ ...base, now: now(), terra, deterministic, sol: SOL_NOT_RUN, terraBaseDraft });
    }
  }

  // --- Exactly ONE Sol advisory critique over sanitized, anonymized fictional input. Hard-capped at 1. ---
  const budget = new LiveCallBudget(1);
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

  return buildLiveReport({ ...base, now: now(), terra: REUSED_TERRA, deterministic, sol, terraBaseDraft });
}
