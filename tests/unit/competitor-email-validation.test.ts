import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runValidationHarness, type HarnessSuccess } from '../../src/evaluation/email/harness.js';
import {
  buildReport,
  decideResult,
  hashReport,
  qualityShortfalls,
  renderReportText,
} from '../../src/evaluation/email/validation-report.js';
import { evaluateHardGates } from '../../src/evaluation/email/hard-gates.js';
import { planEnrichment } from '../../src/domain/email/competitor-enrichment.js';
import { CompetitorPatternService } from '../../src/domain/competitor/pattern-service.js';
import { wordingTextFor } from '../../src/domain/competitor/pattern-wording.js';
import {
  type PatternBuildInput,
  type PatternCompetitorInput,
  type PatternEvidenceItem,
} from '../../src/domain/competitor/pattern-types.js';
import { FIXTURE_NOW } from '../../src/fixtures/competitor-email-validation/synthetic-dental-scenario.js';

/** Run the real pipeline once and reuse it across assertions. */
async function successOrThrow(): Promise<HarnessSuccess> {
  const outcome = await runValidationHarness();
  if (!outcome.ok) throw new Error(`harness failed at ${outcome.failureStage}: ${outcome.reason}`);
  return outcome;
}

describe('Phase 7A4A — competitor email quality validation harness', () => {
  it('runs the complete REAL-service fixture pipeline and returns PASS', async () => {
    const outcome = await runValidationHarness();
    expect(outcome.ok).toBe(true);
    const report = buildReport(outcome);
    expect(report.result).toBe('PASS');
    expect(report.pipeline.researchOutcome).toBeTruthy();
    expect(report.pipeline.acceptedCompetitors).toBe(3);
    expect(report.pipeline.evidenceCount).toBeGreaterThan(0);
    expect(report.pipeline.approvedBy).toBe('synthetic-operator-7a4a');
  });

  it('does NOT hand-build the final package: wording is derived by the real pattern logic', async () => {
    const s = await successOrThrow();
    const pattern = s.enrichmentPackage.patterns[0]!;
    // The anonymized wording is exactly what the deterministic pattern-wording function produces.
    expect(pattern.wordingText).toBe(wordingTextFor(pattern.wordingForm));
    expect(pattern.presentCount).toBe(3);
    expect(pattern.usableDenominator).toBe(3);
    // The competitor wording/consequence text is NEVER present in the fixture source (nothing hand-built).
    const fixtureSrc = readFileSync(new URL('../../src/fixtures/competitor-email-validation/synthetic-dental-scenario.ts', import.meta.url), 'utf8');
    expect(fixtureSrc).not.toContain('comparable nearby clinics');
    expect(fixtureSrc).not.toContain('surface a booking action');
  });

  it('requires an APPROVED package: planEnrichment fails closed on a non-approved status', async () => {
    const s = await successOrThrow();
    const draft = { ...s.enrichmentPackage, status: 'DRAFT' as const };
    const findings = s.emailInputs.findings.map((f) => ({ evidenceId: f.id, findingRef: f.findingRef, category: f.category as never }));
    const rejected = planEnrichment({ leadId: s.leadId, language: 'en', package: draft, safeFindings: findings, requestedPatternId: null });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.reason).toMatch(/APPROVED/);
    const accepted = planEnrichment({ leadId: s.leadId, language: 'en', package: s.enrichmentPackage, safeFindings: findings, requestedPatternId: null });
    expect(accepted.ok).toBe(true);
  });

  it('composes a FAIR comparison: baseline and enriched share the base draft and differ only by enrichment', async () => {
    const s = await successOrThrow();
    const firstParagraph = 'On your website, the option to request an appointment';
    // Both emails carry the SAME prospect observation, recommendation, subject, and CTA.
    expect(s.baseline.body).toContain(firstParagraph);
    expect(s.enriched.rendered.body).toContain(firstParagraph);
    expect(s.enriched.rendered.subject).toBe(s.baseline.subject);
    expect(s.baseline.body).toContain('If this is relevant, reply');
    expect(s.enriched.rendered.body).toContain('If this is relevant, reply');
    // The ONLY material difference is the approved competitor section.
    expect(s.baseline.body).not.toContain(s.plan.competitorSentence);
    expect(s.enriched.rendered.body).toContain(s.plan.competitorSentence);
  });

  it('produces a schema-3 enriched artifact in APPROVED_COMPETITOR_PATTERN_PACKAGE mode', async () => {
    const s = await successOrThrow();
    expect(s.enriched.schemaVersion).toBe('email-copy-schema-3');
    expect(s.enriched.schemaOk).toBe(true);
    expect(s.enriched.artifact.competitor_evidence_used).toBe('APPROVED_COMPETITOR_PATTERN_PACKAGE');
    expect(s.baseline.competitorEvidenceUsed).toBe('NONE');
  });

  it('materially aligns the competitor paragraph with the prospect issue', async () => {
    const s = await successOrThrow();
    expect(s.plan.selection.alignment.auditCategory).toBe('BOOKING_FRICTION');
    expect(s.plan.selection.alignment.evidenceCategory).toBe('BOOKING_CTA_VISIBLE');
    expect(s.plan.selection.pattern.category).toBe('BOOKING_CTA_VISIBLE');
  });

  it('scores enriched >= 80 with >= 8 improvement, integrity 20/20, material relevance >= 16, no zero category', async () => {
    const s = await successOrThrow();
    const report = buildReport(s);
    const enriched = report.enriched!.rubric;
    const baseline = report.baseline!.rubric;
    expect(enriched.total).toBeGreaterThanOrEqual(80);
    expect(enriched.total - baseline.total).toBeGreaterThanOrEqual(8);
    expect(enriched.categories.find((c) => c.category === 'integrity')!.points).toBe(20);
    expect(enriched.categories.find((c) => c.category === 'materialRelevance')!.points).toBeGreaterThanOrEqual(16);
    expect(enriched.categories.some((c) => c.points === 0)).toBe(false);
  });

  it('message hash, package hash, and report determinism hash are stable across runs', async () => {
    const a = buildReport(await runValidationHarness());
    const b = buildReport(await runValidationHarness());
    expect(a.composedMessageHash).toBe(b.composedMessageHash);
    expect(a.pipeline.packageHash).toBe(b.pipeline.packageHash);
    expect(a.determinismHash).toBe(b.determinismHash);
    // Re-hashing the report reproduces the stored determinism hash (review verification).
    expect(hashReport(a)).toBe(a.determinismHash);
  });

  it('every claim-ledger span resolves into the rendered enriched body', async () => {
    const s = await successOrThrow();
    for (const entry of s.enriched.ledger) {
      if (entry.claimType === 'CTA') continue;
      expect(s.enriched.rendered.body).toContain(entry.text);
    }
  });
});

describe('Phase 7A4A — decision logic (safety overrides score)', () => {
  it('PASS only when hard gates pass and no quality shortfalls', () => {
    expect(decideResult(true, [], []).result).toBe('PASS');
  });

  it('REVISE when hard gates pass but quality thresholds are unmet', () => {
    expect(decideResult(true, [], ['improvement 2 < 8']).result).toBe('REVISE');
  });

  it('FAIL (safety overrides) even with a perfect score when a hard gate fails', () => {
    expect(decideResult(false, ['competitor_identity_or_domain_leakage'], []).result).toBe('FAIL');
  });

  it('flags REVISE when the enriched email does not beat the baseline by 8', async () => {
    const s = await successOrThrow();
    const report = buildReport(s);
    // Identical scores => zero improvement => shortfall => REVISE.
    const same = qualityShortfalls(report.baseline!.rubric, report.baseline!.rubric);
    expect(same.some((r) => r.includes('improvement'))).toBe(true);
    expect(decideResult(true, [], same).result).toBe('REVISE');
  });
});

describe('Phase 7A4A — hard gate sensitivity', () => {
  it('all sixteen hard gates pass on the real enriched artifact', async () => {
    const s = await successOrThrow();
    const gates = evaluateHardGates(s);
    expect(gates.allPassed).toBe(true);
    expect(gates.gates).toHaveLength(17);
  });

  it('competitor identity leakage fails the leakage gate', async () => {
    const s = await successOrThrow();
    const mutated: HarnessSuccess = { ...s, enriched: { ...s.enriched, enrichedValidation: { ok: false, violations: [...s.enriched.enrichedValidation.violations, 'competitor_identity_leak:aldergrove'] } } };
    const gates = evaluateHardGates(mutated);
    expect(gates.allPassed).toBe(false);
    expect(gates.failedIds).toContain('competitor_identity_or_domain_leakage');
  });

  it('a competitor count mismatch fails the count gate', async () => {
    const s = await successOrThrow();
    const mutated: HarnessSuccess = { ...s, enriched: { ...s.enriched, enrichedValidation: { ok: false, violations: [...s.enriched.enrichedValidation.violations, 'competitor_count_wording_mismatch'] } } };
    expect(evaluateHardGates(mutated).failedIds).toContain('incorrect_competitor_count');
  });

  it('stale/unsafe evidence fails the freshness gate', async () => {
    const s = await successOrThrow();
    const mutated: HarnessSuccess = { ...s, revalidationFreshnessFailures: ['competitor evidence evi-0001 is now stale'] };
    expect(evaluateHardGates(mutated).failedIds).toContain('stale_or_unsafe_evidence');
  });

  it('a package hash mismatch fails the hash gate', async () => {
    const s = await successOrThrow();
    const mutated: HarnessSuccess = { ...s, revalidationHashMatched: false };
    expect(evaluateHardGates(mutated).failedIds).toContain('package_hash_mismatch');
  });
});

// --- Deterministic evidence + competitor builders for the G1 negative-observation test. ---
function bookingEvidence(id: string, candidateId: string): PatternEvidenceItem {
  return {
    id, captureRunId: 'cap-run', competitorCandidateId: candidateId, evidenceCategory: 'BOOKING_CTA_VISIBLE',
    observationKind: 'DIRECT_OBSERVATION', confidence: 'HIGH', storedFreshness: 'FRESH', safeForOutreach: true,
    active: true, sourcePageUrl: `https://${candidateId}.example`, numericValue: null, capturedAt: FIXTURE_NOW,
    polarity: 'PRESENT', inspectionScope: null,
  };
}
function competitor(candidateId: string, evidence: PatternEvidenceItem[]): PatternCompetitorInput {
  return { competitorCandidateId: candidateId, brandKey: candidateId, businessName: candidateId, parentBrand: null, selected: true, captureActive: true, capturedOk: true, evidence };
}
function buildInput(negatives: PatternBuildInput['prospect']['negatives']): PatternBuildInput {
  return {
    leadId: 'lead-x', researchRunId: 'rr', captureRunIds: ['cap-run'],
    competitors: [
      competitor('alpha', [bookingEvidence('e1', 'alpha')]),
      competitor('beta', [bookingEvidence('e2', 'beta')]),
      competitor('gamma', [bookingEvidence('e3', 'gamma')]),
    ],
    prospect: { leadId: 'lead-x', captureRunId: 'pc-1', capturedAt: FIXTURE_NOW, capturedOk: true, refs: [], negatives },
    now: FIXTURE_NOW, maxAgeDays: 30,
  };
}

describe('Phase 7A4A — G1 explicit scoped prospect negative', () => {
  const svc = new CompetitorPatternService({ uow: { transaction: async () => { throw new Error('no persist'); } } });

  it('an explicit, scoped ABSENT negative yields a verified prospect contrast', () => {
    const built = svc.build(buildInput([{ category: 'BOOKING_CTA_VISIBLE', inspectionScope: 'mobile-initial-viewport', evidenceRef: 'pc-1' }]));
    expect(built.package.contrasts).toHaveLength(1);
    expect(built.package.contrasts[0]!.category).toBe('BOOKING_CTA_VISIBLE');
    expect(built.package.contrasts[0]!.prospectState).toBe('ABSENT');
  });

  it('a MISSING negative stays UNKNOWN — no contrast is inferred', () => {
    const built = svc.build(buildInput([]));
    expect(built.package.contrasts).toHaveLength(0);
    // A positive competitor pattern still exists; only the prospect contrast is withheld.
    expect(built.package.patterns.some((p) => p.category === 'BOOKING_CTA_VISIBLE')).toBe(true);
  });
});

describe('Phase 7A4A — offline safety (no network/DB/live-model/Gmail/Sheets/draft/send)', () => {
  const files = [
    'harness.ts', 'inmemory-competitor-stores.ts', 'email-quality-rubric.ts',
    'hard-gates.ts', 'validation-report.ts', 'constants.ts',
  ];
  // Module-path patterns are checked against IMPORT lines only (doc comments may mention these terms).
  const forbiddenImports = [/persistence\/db/, /repositories\//, /\/gmail/i, /sheet/i, /playwright/i, /HttpGmail/, /HttpSheets/, /node:https?/];
  // Runtime-usage patterns are checked against the whole source.
  const forbiddenUsage = [/\bfetch\s*\(/, /DATABASE_URL/, /new Http/, /PlaywrightCaptureProvider/];

  it('the harness uses only the deterministic mock capture provider', () => {
    const src = readFileSync(new URL('../../src/evaluation/email/harness.ts', import.meta.url), 'utf8');
    expect(src).toContain('MockCaptureProvider');
    expect(src).not.toContain('PlaywrightCaptureProvider');
  });

  it('no evaluation/email source imports a database, network, Gmail, Sheets, draft, or send path', () => {
    for (const f of files) {
      const src = readFileSync(new URL(`../../src/evaluation/email/${f}`, import.meta.url), 'utf8');
      const importLines = src.split('\n').filter((l) => l.trim().startsWith('import')).join('\n');
      for (const pattern of forbiddenImports) {
        expect(pattern.test(importLines), `${f} imports must not match ${String(pattern)}`).toBe(false);
      }
      for (const pattern of forbiddenUsage) {
        expect(pattern.test(src), `${f} must not match ${String(pattern)}`).toBe(false);
      }
    }
  });

  it('the report renders text without throwing (review path)', async () => {
    const report = buildReport(await runValidationHarness());
    expect(renderReportText(report)).toContain('result: PASS');
  });
});
