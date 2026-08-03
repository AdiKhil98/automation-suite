import { describe, expect, it } from 'vitest';
import { MockLlmProvider, type MockResponder } from '../../src/integrations/llm/mock-llm.js';
import { runLiveValidation, type LiveOrchestratorConfig } from '../../src/evaluation/email/live/live-orchestrator.js';
import {
  buildLiveValidationProvider,
  LiveGuardError,
  type LiveGuardOptions,
} from '../../src/evaluation/email/live/live-provider.js';
import { decideCombinedStatus, hashLiveReport, selectReportsToPrune } from '../../src/evaluation/email/live/live-report.js';
import { LiveBudgetError, LiveCallBudget } from '../../src/evaluation/email/live/live-types.js';
import { assertNoCompetitorIdentities, buildSolCritiqueInput, SolSanitizationError } from '../../src/evaluation/email/live/sol-critique-input.js';
import { runValidationHarness, type HarnessSuccess } from '../../src/evaluation/email/harness.js';
import { buildReport } from '../../src/evaluation/email/validation-report.js';
import { defaultMockLiveValidationResponder } from '../../src/fixtures/mock-live-validation-responses.js';
import { baseEmailDraft } from '../../src/fixtures/competitor-email-validation/synthetic-dental-scenario.js';
import { solRatesEnrichedMateriallyWorse, SOL_CRITIQUE_SCHEMA_NAME, type SolCritiqueParsed } from '../../src/domain/email/sol-critique-schema.js';
import { type AppConfig } from '../../src/config/env.js';
import { createLogger } from '../../src/utils/logger.js';

const COMPETITOR_TOKENS = ['aldergrove', 'brackenfield', 'cindermoor'];

const CONFIG: LiveOrchestratorConfig = {
  terraModel: 'gpt-5.6-terra',
  solModel: 'gpt-5.6-sol',
  terraEffort: 'medium',
  solEffort: 'medium',
  store: false,
  timeoutMs: 1_000,
  maxOutputTokens: 1_500,
  maxCostUsd: 0.4,
  maxLiveCalls: 2,
};

function mock(responder: MockResponder = defaultMockLiveValidationResponder): MockLlmProvider {
  return new MockLlmProvider(responder);
}

const cleanSol = (over: Partial<SolCritiqueParsed> = {}): SolCritiqueParsed => ({
  preferredVersion: 'ENRICHED',
  baselineQualityScore: 80,
  enrichedQualityScore: 95,
  naturalnessAssessment: 'natural',
  credibilityAssessment: 'credible',
  flowAssessment: 'flows',
  mechanicalWordingDetected: false,
  unsupportedClaimSuspected: false,
  criticalIssues: [],
  improvementSuggestions: [],
  advisoryVerdict: 'PASS',
  ...over,
});

describe('Phase 7A4B — guarded live-model validation orchestrator', () => {
  it('successful mock run: exactly one Terra + one Sol call, READY_FOR_OPERATOR_REVIEW', async () => {
    const provider = mock();
    const report = await runLiveValidation({ provider, config: CONFIG, mode: 'MOCK' });

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0]!.task).toBe('email_write');
    expect(provider.calls[1]!.task).toBe('email_review');
    expect(provider.calls[1]!.schemaName).toBe(SOL_CRITIQUE_SCHEMA_NAME);
    expect(report.budget.terraCalls).toBe(1);
    expect(report.budget.solCalls).toBe(1);
    expect(report.budget.totalCalls).toBe(2);
    expect(report.deterministic?.result).toBe('PASS');
    expect(report.combinedStatus).toBe('READY_FOR_OPERATOR_REVIEW');
    expect(report.routing.terraRole).toBe('BASE_GENERATION');
    expect(report.routing.solRole).toBe('ADVISORY_CRITIQUE');
  });

  it('uses the SAME single Terra artifact for baseline and enriched (only one email_write call)', async () => {
    const provider = mock();
    const report = await runLiveValidation({ provider, config: CONFIG, mode: 'MOCK' });
    const writeCalls = provider.calls.filter((c) => c.task === 'email_write');
    expect(writeCalls).toHaveLength(1);
    // Baseline body is the (mock) Terra base; enriched adds the competitor sentence to that same base.
    expect(report.deterministic?.baseline?.evidenceMode).toBe('NONE');
    expect(report.deterministic?.enriched?.evidenceMode).toBe('APPROVED_COMPETITOR_PATTERN_PACKAGE');
    expect(report.deterministic?.enriched?.body).toContain(report.deterministic!.baseline!.body.split('\n')[0]!);
  });

  it('sends NO competitor context to Terra', async () => {
    const provider = mock();
    await runLiveValidation({ provider, config: CONFIG, mode: 'MOCK' });
    const terra = provider.calls[0]!;
    const haystack = `${terra.system}\n${terra.user}`.toLowerCase();
    for (const token of COMPETITOR_TOKENS) expect(haystack).not.toContain(token);
    expect(haystack).toContain('competitor research package: none');
  });

  it('sends NO competitor identity to Sol', async () => {
    const provider = mock();
    await runLiveValidation({ provider, config: CONFIG, mode: 'MOCK' });
    const sol = provider.calls[1]!;
    const haystack = `${sol.system}\n${sol.user}`.toLowerCase();
    for (const token of COMPETITOR_TOKENS) expect(haystack).not.toContain(token);
  });

  it('malformed Terra fails closed and STOPS before Sol', async () => {
    const responder: MockResponder = (req) => (req.task === 'email_write' ? { rawJson: { bad: true } } : { rawJson: cleanSol() });
    const provider = mock(responder);
    const report = await runLiveValidation({ provider, config: CONFIG, mode: 'MOCK' });

    expect(provider.calls).toHaveLength(1); // Terra only; Sol never called
    expect(report.terra.ok).toBe(false);
    expect(report.terra.reason).toBe('TERRA_MALFORMED_RESPONSE');
    expect(report.sol.ran).toBe(false);
    expect(report.deterministic).toBeNull();
    expect(report.combinedStatus).toBe('VALIDATION_FAILED');
  });

  it('Terra refusal fails closed before Sol', async () => {
    const responder: MockResponder = (req) => (req.task === 'email_write' ? { status: 'refusal', refusal: 'no' } : { rawJson: cleanSol() });
    const provider = mock(responder);
    const report = await runLiveValidation({ provider, config: CONFIG, mode: 'MOCK' });
    expect(provider.calls).toHaveLength(1);
    expect(report.terra.reason).toBe('TERRA_PROVIDER_REFUSAL');
    expect(report.combinedStatus).toBe('VALIDATION_FAILED');
  });

  it('malformed Sol fails closed as an advisory failure (deterministic PASS unchanged)', async () => {
    const responder: MockResponder = (req) => (req.task === 'email_write' ? { rawJson: { ...baseEmailDraft } } : { rawJson: { garbage: true } });
    const provider = mock(responder);
    const report = await runLiveValidation({ provider, config: CONFIG, mode: 'MOCK' });

    expect(provider.calls).toHaveLength(2);
    expect(report.deterministic?.result).toBe('PASS');
    expect(report.sol.ran).toBe(true);
    expect(report.sol.malformed).toBe(true);
    expect(report.combinedStatus).toBe('REQUIRES_REVISION');
  });

  it('Sol cannot alter the email artifacts — only the combined status', async () => {
    const clean = mock();
    const failResponder: MockResponder = (req) => (req.task === 'email_write'
      ? { rawJson: { ...baseEmailDraft } }
      : { rawJson: cleanSol({ preferredVersion: 'BASELINE', baselineQualityScore: 90, enrichedQualityScore: 30, advisoryVerdict: 'FAIL', criticalIssues: ['x'], mechanicalWordingDetected: true, unsupportedClaimSuspected: true }) });
    const dirty = mock(failResponder);

    const a = await runLiveValidation({ provider: clean, config: CONFIG, mode: 'MOCK' });
    const b = await runLiveValidation({ provider: dirty, config: CONFIG, mode: 'MOCK' });

    // Identical enriched artifact regardless of Sol output.
    expect(b.deterministic?.enriched?.body).toBe(a.deterministic?.enriched?.body);
    expect(b.deterministic?.enriched?.subject).toBe(a.deterministic?.enriched?.subject);
    // Only the advisory-driven combined status differs.
    expect(a.combinedStatus).toBe('READY_FOR_OPERATOR_REVIEW');
    expect(b.combinedStatus).toBe('REQUIRES_REVISION');
  });

  it('report hash is stable across identical mock runs and self-consistent', async () => {
    const a = await runLiveValidation({ provider: mock(), config: CONFIG, mode: 'MOCK' });
    const b = await runLiveValidation({ provider: mock(), config: CONFIG, mode: 'MOCK' });
    expect(a.reportHash).toBe(b.reportHash);
    expect(hashLiveReport(a)).toBe(a.reportHash);
  });

  it('runs with only a mock provider — no database, Gmail, or Sheets handle required', async () => {
    // The orchestrator takes ONLY a provider; a successful run proves no DB/Gmail/Sheets dependency.
    const report = await runLiveValidation({ provider: mock(), config: CONFIG, mode: 'MOCK' });
    expect(report.combinedStatus).toBe('READY_FOR_OPERATOR_REVIEW');
  });
});

describe('Phase 7A4B — live call budget (hard ceiling 2)', () => {
  it('LiveCallBudget throws on exceeding the max', () => {
    const budget = new LiveCallBudget(2);
    budget.reserve('TERRA_BASE');
    budget.reserve('SOL_CRITIQUE');
    expect(() => budget.reserve('SOL_CRITIQUE')).toThrow(LiveBudgetError);
  });

  it('orchestrator with maxLiveCalls=1 cannot make the Sol call', async () => {
    await expect(runLiveValidation({ provider: mock(), config: { ...CONFIG, maxLiveCalls: 1 }, mode: 'MOCK' })).rejects.toBeInstanceOf(LiveBudgetError);
  });
});

describe('Phase 7A4B — combined status (safety overrides advice)', () => {
  it('deterministic FAIL is VALIDATION_FAILED even when Sol is clean', () => {
    const r = decideCombinedStatus({ terraOk: true, deterministicResult: 'FAIL', sol: { ran: true, malformed: false, unsupportedClaimSuspected: false, criticalIssueCount: 0, materiallyWorse: false, advisoryVerdict: 'PASS' } });
    expect(r.status).toBe('VALIDATION_FAILED');
  });

  it('Terra failure is VALIDATION_FAILED (no deterministic result)', () => {
    expect(decideCombinedStatus({ terraOk: false, deterministicResult: null, sol: null }).status).toBe('VALIDATION_FAILED');
  });

  it('deterministic PASS + clean Sol is READY_FOR_OPERATOR_REVIEW', () => {
    const r = decideCombinedStatus({ terraOk: true, deterministicResult: 'PASS', sol: { ran: true, malformed: false, unsupportedClaimSuspected: false, criticalIssueCount: 0, materiallyWorse: false, advisoryVerdict: 'PASS' } });
    expect(r.status).toBe('READY_FOR_OPERATOR_REVIEW');
  });

  it('PASS + Sol unsupported-claim / critical issue / materially worse downgrades to REQUIRES_REVISION', () => {
    const base = { terraOk: true, deterministicResult: 'PASS' as const };
    expect(decideCombinedStatus({ ...base, sol: { ran: true, malformed: false, unsupportedClaimSuspected: true, criticalIssueCount: 0, materiallyWorse: false, advisoryVerdict: 'PASS' } }).status).toBe('REQUIRES_REVISION');
    expect(decideCombinedStatus({ ...base, sol: { ran: true, malformed: false, unsupportedClaimSuspected: false, criticalIssueCount: 2, materiallyWorse: false, advisoryVerdict: 'PASS' } }).status).toBe('REQUIRES_REVISION');
    expect(decideCombinedStatus({ ...base, sol: { ran: true, malformed: false, unsupportedClaimSuspected: false, criticalIssueCount: 0, materiallyWorse: true, advisoryVerdict: 'PASS' } }).status).toBe('REQUIRES_REVISION');
  });

  it('deterministic REVISE is REQUIRES_REVISION even with a clean Sol', () => {
    const r = decideCombinedStatus({ terraOk: true, deterministicResult: 'REVISE', sol: { ran: true, malformed: false, unsupportedClaimSuspected: false, criticalIssueCount: 0, materiallyWorse: false, advisoryVerdict: 'PASS' } });
    expect(r.status).toBe('REQUIRES_REVISION');
  });
});

describe('Phase 7A4B — materially-worse threshold (10-point band)', () => {
  it('enriched <= baseline - 10 is materially worse; a smaller gap is not', () => {
    expect(solRatesEnrichedMateriallyWorse(cleanSol({ baselineQualityScore: 80, enrichedQualityScore: 70 }))).toBe(true);
    expect(solRatesEnrichedMateriallyWorse(cleanSol({ baselineQualityScore: 80, enrichedQualityScore: 71 }))).toBe(false);
    expect(solRatesEnrichedMateriallyWorse(cleanSol({ baselineQualityScore: 90, enrichedQualityScore: 95 }))).toBe(false);
  });
});

describe('Phase 7A4B — Sol input sanitization', () => {
  it('assertNoCompetitorIdentities throws when a token would leak', async () => {
    const outcome = (await runValidationHarness()) as HarnessSuccess;
    const report = buildReport(outcome);
    const input = buildSolCritiqueInput(outcome, report);
    // A clean input passes; a poisoned one is rejected.
    expect(() => assertNoCompetitorIdentities(input, ['Aldergrove'])).not.toThrow();
    const poisoned = { ...input, enrichedBody: `${input.enrichedBody} Aldergrove` };
    expect(() => assertNoCompetitorIdentities(poisoned, ['Aldergrove'])).toThrow(SolSanitizationError);
  });
});

describe('Phase 7A4B — provider guards (no mock fallback under live intent)', () => {
  const logger = createLogger('silent');
  const fullLive = (over: Partial<AppConfig> = {}): AppConfig => ({
    COMPETITOR_EMAIL_LIVE_VALIDATION_ENABLED: true,
    COMPETITOR_EMAIL_LIVE_VALIDATION_TERRA_MODEL: 'gpt-5.6-terra',
    COMPETITOR_EMAIL_LIVE_VALIDATION_SOL_MODEL: 'gpt-5.6-sol',
    LLM_PROVIDER: 'openai',
    ALLOW_PAID_LLM_CALLS: true,
    OPENAI_API_KEY: 'sk-test',
    LLM_STORE_RESPONSES: false,
    ...over,
  } as unknown as AppConfig);
  const liveOpts: LiveGuardOptions = { confirmLive: true, fixtureId: 'synthetic-dental', confirmNoRealProspect: true, maxLiveCalls: 2 };

  it('without --confirm-live returns the deterministic mock provider', () => {
    const built = buildLiveValidationProvider(fullLive(), logger, { ...liveOpts, confirmLive: false });
    expect(built.mode).toBe('MOCK');
    expect(built.provider.name).toBe('mock');
  });

  it('with all guards satisfied builds the real OpenAI provider (no call made)', () => {
    const built = buildLiveValidationProvider(fullLive(), logger, liveOpts);
    expect(built.mode).toBe('LIVE');
    expect(built.provider.name).toBe('openai');
  });

  it('each missing guard throws under --confirm-live (never falls back to mock)', () => {
    expect(() => buildLiveValidationProvider(fullLive({ COMPETITOR_EMAIL_LIVE_VALIDATION_ENABLED: false }), logger, liveOpts)).toThrow(LiveGuardError);
    expect(() => buildLiveValidationProvider(fullLive({ LLM_PROVIDER: 'mock' }), logger, liveOpts)).toThrow(LiveGuardError);
    expect(() => buildLiveValidationProvider(fullLive({ ALLOW_PAID_LLM_CALLS: false }), logger, liveOpts)).toThrow(LiveGuardError);
    expect(() => buildLiveValidationProvider(fullLive({ OPENAI_API_KEY: undefined }), logger, liveOpts)).toThrow(LiveGuardError);
    expect(() => buildLiveValidationProvider(fullLive(), logger, { ...liveOpts, fixtureId: 'real-clinic' })).toThrow(LiveGuardError);
    expect(() => buildLiveValidationProvider(fullLive(), logger, { ...liveOpts, confirmNoRealProspect: false })).toThrow(LiveGuardError);
    expect(() => buildLiveValidationProvider(fullLive(), logger, { ...liveOpts, maxLiveCalls: 3 })).toThrow(LiveGuardError);
    expect(() => buildLiveValidationProvider(fullLive({ COMPETITOR_EMAIL_LIVE_VALIDATION_SOL_MODEL: 'gpt-unknown' }), logger, liveOpts)).toThrow(LiveGuardError);
  });
});

describe('Phase 7A4B — real-provider cost gate + artifact retention', () => {
  it('blocks a live run when a configured model has no verified price', async () => {
    // A non-mock provider double with an unpriced model triggers the pre-call cost gate (no call made).
    const provider = new MockLlmProvider(defaultMockLiveValidationResponder);
    Object.defineProperty(provider, 'name', { value: 'openai' });
    const report = await runLiveValidation({ provider, config: { ...CONFIG, solModel: 'gpt-unknown' }, mode: 'LIVE' });
    expect(provider.calls).toHaveLength(0);
    expect(report.terra.reason).toBe('LIVE_BUDGET_BLOCKED');
    expect(report.combinedStatus).toBe('VALIDATION_FAILED');
  });

  it('retention keeps only the latest N and drops reports older than the window', () => {
    const now = new Date('2026-08-03T00:00:00.000Z');
    const day = 24 * 60 * 60 * 1000;
    const files = [
      { name: 'live-report-1.json', mtimeMs: now.getTime() - 1 * day },
      { name: 'live-report-2.json', mtimeMs: now.getTime() - 2 * day },
      { name: 'live-report-3.json', mtimeMs: now.getTime() - 3 * day },
      { name: 'live-report-old.json', mtimeMs: now.getTime() - 40 * day },
    ];
    const pruned = selectReportsToPrune(files, 30, 2, now);
    expect(pruned).toContain('live-report-3.json'); // beyond keepLatest=2
    expect(pruned).toContain('live-report-old.json'); // older than 30 days
    expect(pruned).not.toContain('live-report-1.json');
    expect(pruned).not.toContain('live-report-2.json');
  });
});
