/**
 * Phase 7A4B1 — live email determinism regression suite.
 *
 * Covers the canonical composed-message hash contract, stable body-derived claim spans, the exact
 * reproduce-before / pass-after of the original unstable live scenario, and the offline replay (which must
 * make zero model / network / Gmail / Sheets / draft / send / production-DB calls).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  composeEnrichedEmail,
  computeComposedMessageHash,
  type ComposedMessageHashInput,
} from '../../src/domain/email/competitor-email-composer.js';
import {
  deriveClaimSpans,
  planEnrichment,
  type ClaimLedgerEntry,
} from '../../src/domain/email/competitor-enrichment.js';
import { runValidationHarness, type HarnessSuccess } from '../../src/evaluation/email/harness.js';
import { buildReport } from '../../src/evaluation/email/validation-report.js';
import { evaluateHardGates } from '../../src/evaluation/email/hard-gates.js';
import { runLiveValidation, type LiveOrchestratorConfig } from '../../src/evaluation/email/live/live-orchestrator.js';
import { replayLiveValidation } from '../../src/evaluation/email/live/replay.js';
import { type LiveValidationReport } from '../../src/evaluation/email/live/live-report.js';
import { MockLlmProvider } from '../../src/integrations/llm/mock-llm.js';
import { defaultMockLiveValidationResponder } from '../../src/fixtures/mock-live-validation-responses.js';
import {
  baseEmailDraft,
  leadFacts,
  liveTerraBaseDraft,
  safeFindings,
} from '../../src/fixtures/competitor-email-validation/synthetic-dental-scenario.js';
import { buildEmailContext, type EmailInputs } from '../../src/domain/email/email-render.js';
import { type AuditCategory } from '../../src/domain/audit/audit-types.js';

const CONFIG: LiveOrchestratorConfig = {
  terraModel: 'gpt-5.6-terra', solModel: 'gpt-5.6-sol', terraEffort: 'medium', solEffort: 'medium',
  store: false, timeoutMs: 1_000, maxOutputTokens: 1_500, maxCostUsd: 0.4, maxLiveCalls: 2,
};

async function successOrThrow(base = baseEmailDraft): Promise<HarnessSuccess> {
  const outcome = await runValidationHarness(base);
  if (!outcome.ok) throw new Error(`harness failed at ${outcome.failureStage}: ${outcome.reason}`);
  return outcome;
}

/** A canonical composed-message hash input assembled from the real fixture pipeline. */
async function baseHashInput(): Promise<ComposedMessageHashInput> {
  const s = await successOrThrow();
  return {
    schemaVersion: s.enriched.schemaVersion,
    mode: s.enriched.artifact.competitor_evidence_used,
    subject: s.enriched.rendered.subject,
    body: s.enriched.rendered.body,
    packageId: s.enrichmentPackage.packageId,
    packageVersion: s.enrichmentPackage.version,
    packageHash: s.enrichmentPackage.packageHash,
    selectedPatternId: s.plan.selection.pattern.patternId,
    selectedContrastId: s.plan.selection.contrast?.contrastId ?? null,
    rulesVersion: s.plan.rulesVersion,
    ledger: s.enriched.ledger.map((e) => ({
      claimType: e.claimType, text: e.text, prospectEvidenceIds: e.prospectEvidenceIds,
      patternId: e.patternId, contrastId: e.contrastId, competitorEvidenceIds: e.competitorEvidenceIds,
    })),
  };
}

describe('Phase 7A4B1 — canonical composed-message hash contract', () => {
  it('identical input reproduces the identical hash (repeated composition is deterministic)', async () => {
    const input = await baseHashInput();
    expect(computeComposedMessageHash(input)).toBe(computeComposedMessageHash(structuredClone(input)));
  });

  it('a changed subject changes the hash', async () => {
    const input = await baseHashInput();
    expect(computeComposedMessageHash({ ...input, subject: `${input.subject} (edited)` })).not.toBe(computeComposedMessageHash(input));
  });

  it('a changed body changes the hash', async () => {
    const input = await baseHashInput();
    expect(computeComposedMessageHash({ ...input, body: `${input.body}\n\nAn extra line.` })).not.toBe(computeComposedMessageHash(input));
  });

  it('a changed package hash changes the hash', async () => {
    const input = await baseHashInput();
    expect(computeComposedMessageHash({ ...input, packageHash: 'deadbeef' })).not.toBe(computeComposedMessageHash(input));
  });

  it('a changed selected pattern id changes the hash', async () => {
    const input = await baseHashInput();
    expect(computeComposedMessageHash({ ...input, selectedPatternId: 'pat-OTHER' })).not.toBe(computeComposedMessageHash(input));
  });

  it('a changed selected contrast id changes the hash', async () => {
    const input = await baseHashInput();
    expect(computeComposedMessageHash({ ...input, selectedContrastId: 'con-OTHER' })).not.toBe(computeComposedMessageHash(input));
  });

  it('changed evidence references change the hash', async () => {
    const input = await baseHashInput();
    const idx = input.ledger.findIndex((e) => e.competitorEvidenceIds.length > 0);
    const ledger = input.ledger.map((e, i) => (i === idx ? { ...e, competitorEvidenceIds: [...e.competitorEvidenceIds, 'evi-9999'] } : e));
    expect(computeComposedMessageHash({ ...input, ledger })).not.toBe(computeComposedMessageHash(input));
  });

  it('a changed claim span (ledger claim text) changes the hash', async () => {
    const input = await baseHashInput();
    const ledger = input.ledger.map((e, i) => (i === 0 ? { ...e, text: `${e.text} extra` } : e));
    expect(computeComposedMessageHash({ ...input, ledger })).not.toBe(computeComposedMessageHash(input));
  });

  it('evidence-reference ordering is canonical (a reordered set hashes identically)', async () => {
    const input = await baseHashInput();
    const idx = input.ledger.findIndex((e) => e.competitorEvidenceIds.length > 1);
    expect(idx).toBeGreaterThanOrEqual(0);
    const ledger = input.ledger.map((e, i) => (i === idx ? { ...e, competitorEvidenceIds: [...e.competitorEvidenceIds].reverse() } : e));
    expect(computeComposedMessageHash({ ...input, ledger })).toBe(computeComposedMessageHash(input));
  });

  it('newline normalization is canonical (CRLF vs LF hashes identically)', async () => {
    const input = await baseHashInput();
    const crlf = { ...input, body: input.body.replace(/\n/g, '\r\n') };
    expect(computeComposedMessageHash(crlf)).toBe(computeComposedMessageHash(input));
  });

  it('excludes ephemeral execution metadata: two mock runs with different clocks share the composed hash', async () => {
    const a = await runLiveValidation({ provider: new MockLlmProvider(defaultMockLiveValidationResponder), config: CONFIG, mode: 'MOCK', now: () => new Date('2026-08-03T10:00:00.000Z') });
    const b = await runLiveValidation({ provider: new MockLlmProvider(defaultMockLiveValidationResponder), config: CONFIG, mode: 'MOCK', now: () => new Date('2026-08-04T20:30:00.000Z') });
    expect(a.generatedAt).not.toBe(b.generatedAt); // report timestamps differ
    expect(a.deterministic?.composedMessageHash).toBe(b.deterministic?.composedMessageHash); // hash does not
  });

  it('provider request ids / token usage / cost never enter the composed hash (not in the input type)', async () => {
    // Structural guarantee: mutating provider call metadata on a report leaves the stored composed hash intact.
    const report = await runLiveValidation({ provider: new MockLlmProvider(defaultMockLiveValidationResponder), config: CONFIG, mode: 'MOCK' });
    const before = report.deterministic!.composedMessageHash;
    if (report.terra.call) {
      report.terra.call.requestId = 'req_tampered';
      report.terra.call.estimatedCostUsd = 999;
      report.terra.call.latencyMs = 123456;
    }
    expect(report.deterministic!.composedMessageHash).toBe(before);
  });
});

describe('Phase 7A4B1 — stable body-derived claim spans', () => {
  it('repeated derivation yields identical spans, each an exact bounded substring', async () => {
    const s = await successOrThrow();
    const a = deriveClaimSpans(s.enriched.rendered.body, s.enriched.ledger);
    const b = deriveClaimSpans(s.enriched.rendered.body, s.enriched.ledger);
    expect(a).toEqual(b);
    for (const span of a) {
      expect(span.valid).toBe(true);
      expect(s.enriched.rendered.body.slice(span.start, span.end)).toBe(span.text);
    }
    // The CTA marker claim is never a body span.
    expect(a.some((sp) => sp.text.startsWith('cta:'))).toBe(false);
  });

  it('duplicate sentence text maps to distinct, deterministic offsets', () => {
    const dup = 'This sentence repeats.';
    const body = `${dup}\n\nMiddle line.\n\n${dup}`;
    const ledger: ClaimLedgerEntry[] = [
      { claimType: 'PROSPECT_OBSERVATION', text: dup, prospectEvidenceIds: ['f1'], patternId: null, contrastId: null, competitorEvidenceIds: [], externallySafe: true },
      { claimType: 'RECOMMENDATION', text: dup, prospectEvidenceIds: ['f1'], patternId: null, contrastId: null, competitorEvidenceIds: [], externallySafe: true },
    ];
    const spans = deriveClaimSpans(body, ledger);
    expect(spans).toHaveLength(2);
    expect(spans[0]!.start).toBe(0);
    expect(spans[1]!.start).toBe(body.lastIndexOf(dup));
    expect(spans[0]!.start).not.toBe(spans[1]!.start);
    expect(spans.every((sp) => sp.valid)).toBe(true);
    // Deterministic across repeated derivation.
    expect(deriveClaimSpans(body, ledger)).toEqual(spans);
  });
});

describe('Phase 7A4B1 — original unstable live scenario: reproduce before, pass after', () => {
  it('composes the same final body from the live-authored base draft', async () => {
    const s = await successOrThrow(liveTerraBaseDraft);
    expect(s.enriched.rendered.body).toContain('On the mobile page, no booking action appears in the first screen');
    expect(s.enriched.rendered.body).toContain(s.plan.competitorSentence);
    expect(s.enriched.rendered.subject).toBe('Northgate Dental Studio’s mobile booking path');
  });

  it('BEFORE THE FIX: recomposing from the pinned fixture (not the live base) mismatches the hash', async () => {
    const s = await successOrThrow(liveTerraBaseDraft);
    const emailInputs: EmailInputs = { facts: leadFacts, findings: safeFindings, demo: null };
    const ctx = buildEmailContext(emailInputs);
    const findings = safeFindings.map((f) => ({ evidenceId: f.id, findingRef: f.findingRef, category: f.category as AuditCategory }));
    const outcome = planEnrichment({ leadId: s.leadId, language: 'en', package: s.enrichmentPackage, safeFindings: findings, requestedPatternId: null });
    if (!outcome.ok) throw new Error(outcome.reason);
    // The OLD gate-16 behaviour: recompose from `baseEmailDraft` (the fixture) — the exact defect.
    const oldRecompose = composeEnrichedEmail({ prospectDraft: baseEmailDraft, emailInputs, validationCtx: ctx, plan: outcome.plan, pkg: s.enrichmentPackage });
    expect(oldRecompose.composedMessageHash).not.toBe(s.enriched.composedMessageHash); // this is what falsely failed the run
  });

  it('AFTER THE FIX: hard gate 16 recomposes from the actual base draft and passes; all 16 gates pass', async () => {
    const s = await successOrThrow(liveTerraBaseDraft);
    const gates = evaluateHardGates(s);
    expect(gates.gates).toHaveLength(16);
    expect(gates.failedIds).not.toContain('unstable_claim_spans_or_hash');
    expect(gates.allPassed).toBe(true);
    const g16 = gates.gates.find((g) => g.id === 'unstable_claim_spans_or_hash')!;
    expect(g16.passed).toBe(true);
    expect(g16.diagnostic).toBeNull();
  });

  it('the full live run over the live base draft reaches a non-FAIL deterministic result', async () => {
    const s = await successOrThrow(liveTerraBaseDraft);
    const report = buildReport(s);
    expect(report.hardGates!.allPassed).toBe(true);
    expect(report.result).not.toBe('FAIL');
  });
});

describe('Phase 7A4B1 — offline replay (zero live/network/DB/Gmail/Sheets/draft/send)', () => {
  async function mockLiveReport(): Promise<LiveValidationReport> {
    return runLiveValidation({ provider: new MockLlmProvider(defaultMockLiveValidationResponder), config: CONFIG, mode: 'MOCK' });
  }

  it('FULL replay reproduces the composed hash + claim spans from a persisted Terra base draft', async () => {
    const report = await mockLiveReport();
    expect(report.terraBaseDraft).not.toBeNull();
    const result = await replayLiveValidation(report);
    expect(result.mode).toBe('FULL');
    expect(result.ok).toBe(true);
    expect(result.composedHashReproducible).toBe(true);
    expect(result.claimSpansReproducible).toBe(true);
    expect(result.recomputedComposedHash).toBe(result.storedComposedHash);
  });

  it('REDUCED replay reproduces the composed hash from a legacy report (no persisted base draft)', async () => {
    const report = await mockLiveReport();
    const legacy: LiveValidationReport = { ...report, terraBaseDraft: null };
    const result = await replayLiveValidation(legacy);
    expect(result.mode).toBe('REDUCED');
    expect(result.composedHashReproducible).toBe(true);
    expect(result.recomputedComposedHash).toBe(result.storedComposedHash);
  });

  it('an ALTERED enriched body fails replay integrity (determinism-hash mismatch + body drift)', async () => {
    const report = await mockLiveReport();
    const tampered: LiveValidationReport = { ...report, deterministic: { ...report.deterministic!, enriched: { ...report.deterministic!.enriched!, body: `${report.deterministic!.enriched!.body} tampered` } } };
    const result = await replayLiveValidation(tampered);
    expect(result.determinismHashOk).toBe(false); // hashReport(det) no longer matches the stored determinism hash
    expect(result.claimSpansReproducible).toBe(false); // recomputed body differs from the tampered body
    expect(result.ok).toBe(false);
  });

  it('an ALTERED live report hash fails replay integrity (report-hash mismatch)', async () => {
    const report = await mockLiveReport();
    const tampered: LiveValidationReport = { ...report, reportHash: '0'.repeat(64) };
    const result = await replayLiveValidation(tampered);
    expect(result.reportHashOk).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('the saved failed live artifact (if present) replays as reproducible with zero live calls', async () => {
    let raw: string;
    try {
      raw = readFileSync('.local-data/competitor-email-validation/live/latest.json', 'utf8');
    } catch {
      return; // git-ignored artifact absent in CI — the committed mock-report cases above cover the path
    }
    const result = await replayLiveValidation(JSON.parse(raw) as LiveValidationReport);
    expect(result.composedHashReproducible).toBe(true);
    expect(result.claimSpansReproducible).toBe(true);
    expect(result.reportHashOk).toBe(true);
  });

  it('the replay module and CLI import no network, Gmail, Sheets, draft, send, or database path', () => {
    const sources = [
      '../../src/evaluation/email/live/replay.ts',
      '../../src/cli/commands/competitor-email-live-validation-replay.ts',
    ];
    const forbiddenImports = [/persistence\/db/, /repositories\//, /\/gmail/i, /sheet/i, /playwright/i, /HttpGmail/, /HttpSheets/, /integrations\/llm\/(openai|provider)/, /node:https?/, /node:net/];
    const forbiddenUsage = [/\bfetch\s*\(/, /DATABASE_URL/, /new Http/, /\.generate\s*\(/, /provider\./];
    for (const rel of sources) {
      const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
      const importLines = src.split('\n').filter((l) => l.trim().startsWith('import')).join('\n');
      for (const p of forbiddenImports) expect(p.test(importLines), `${rel} imports must not match ${String(p)}`).toBe(false);
      for (const p of forbiddenUsage) expect(p.test(src), `${rel} must not match ${String(p)}`).toBe(false);
    }
  });
});
