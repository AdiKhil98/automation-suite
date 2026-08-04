/**
 * Phase 7A4B2 — competitor-email copy-flow suite.
 *
 * Covers the structured one-sentence competitor insertion, the structured redundancy gate, category
 * templates, the offline recomposition, and the guarded Sol-only re-review. Every case is deterministic and
 * makes ZERO Terra/Sol, network, Gmail, Sheets, database, draft, or send calls (the re-review uses a mock
 * provider and counts its calls).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildClaimLedger,
  buildCompositionSections,
  CONSEQUENCE_TEMPLATES,
  decideCompetitorRender,
  detectStructuredRedundancy,
  planEnrichment,
  type ClaimLedgerEntry,
  type EnrichmentPackage,
  type EnrichmentPattern,
  type EnrichmentPlan,
  type EnrichmentProspectFinding,
} from '../../src/domain/email/competitor-enrichment.js';
import { runValidationHarness, type HarnessSuccess } from '../../src/evaluation/email/harness.js';
import { evaluateHardGates } from '../../src/evaluation/email/hard-gates.js';
import { recomposeLiveValidation } from '../../src/evaluation/email/live/recompose.js';
import { runSolOnlyRereview, requireValidFullSource, RereviewSourceError } from '../../src/evaluation/email/live/rereview.js';
import { runLiveValidation, type LiveOrchestratorConfig } from '../../src/evaluation/email/live/live-orchestrator.js';
import { type LiveValidationReport } from '../../src/evaluation/email/live/live-report.js';
import { MockLlmProvider, type MockResponder } from '../../src/integrations/llm/mock-llm.js';
import { defaultMockLiveValidationResponder } from '../../src/fixtures/mock-live-validation-responses.js';
import { liveTerraBaseDraft } from '../../src/fixtures/competitor-email-validation/synthetic-dental-scenario.js';
import { type EmailWriterParsed } from '../../src/domain/email/email-schema.js';

const CONFIG: LiveOrchestratorConfig = {
  terraModel: 'gpt-5.6-terra', solModel: 'gpt-5.6-sol', terraEffort: 'medium', solEffort: 'medium',
  store: false, timeoutMs: 1_000, maxOutputTokens: 1_500, maxCostUsd: 0.4, maxLiveCalls: 2,
};

const BANNED = ['surface', 'surfaced', 'surfaced the same way', 'on your own site this option'];

async function successOrThrow(base: EmailWriterParsed): Promise<HarnessSuccess> {
  const outcome = await runValidationHarness(base);
  if (!outcome.ok) throw new Error(`harness failed at ${outcome.failureStage}: ${outcome.reason}`);
  return outcome;
}

// ---------------------------------------------------------------------------
// §1–§4 — one-sentence competitor insertion from the saved Terra base draft
// ---------------------------------------------------------------------------

describe('Phase 7A4B2 — one-sentence competitor insertion (saved Terra base draft)', () => {
  it('recomposes the saved Terra draft offline into a single competitor sentence', async () => {
    const s = await successOrThrow(liveTerraBaseDraft);
    const competitor = s.enriched.sections.filter((x) => x.kind === 'COMPETITOR_PATTERN');
    expect(competitor).toHaveLength(1);
    // Exactly one sentence: one terminal period and no additional stitched sentences.
    expect(competitor[0]!.text).toBe(s.plan.competitorSentence);
    expect(competitor[0]!.text.match(/\./g) ?? []).toHaveLength(1);
  });

  it('preserves the exact three-of-three stored count wording', async () => {
    const s = await successOrThrow(liveTerraBaseDraft);
    expect(s.plan.selection.pattern.wordingText).toBe('all three comparable nearby clinics');
    expect(s.enriched.rendered.body).toContain('All three comparable nearby clinics make booking available directly from their homepage.');
    expect(s.plan.selection.pattern.presentCount).toBe(3);
    expect(s.plan.selection.pattern.usableDenominator).toBe(3);
  });

  it('contains no mechanical "surfaced the same way" / "surface" wording', async () => {
    const s = await successOrThrow(liveTerraBaseDraft);
    const lower = s.enriched.rendered.body.toLowerCase();
    for (const term of BANNED) expect(lower).not.toContain(term);
  });

  it('does not redundantly render the prospect contrast', async () => {
    const s = await successOrThrow(liveTerraBaseDraft);
    expect(s.enriched.ledger.some((e) => e.claimType === 'PROSPECT_CONTRAST')).toBe(false);
  });

  it('does not render the cautious consequence twice (base recommendation already carries it)', async () => {
    const s = await successOrThrow(liveTerraBaseDraft);
    expect(s.enriched.ledger.some((e) => e.claimType === 'CAUTIOUS_CONSEQUENCE')).toBe(false);
    expect(s.enriched.rendered.body).not.toContain(CONSEQUENCE_TEMPLATES.BOOKING_DISCOVERABILITY);
  });

  it('leaves the Terra opening observation unchanged', async () => {
    const s = await successOrThrow(liveTerraBaseDraft);
    const opening = liveTerraBaseDraft.email_body.split(/\n\s*\n/)[0]!.trim();
    expect(s.enriched.rendered.body).toContain(opening);
    expect(s.enriched.sections[0]!.kind).toBe('PROSPECT_OBSERVATION');
    expect(s.enriched.sections[0]!.text).toBe(opening);
  });

  it('leaves the Terra recommendation unchanged', async () => {
    const s = await successOrThrow(liveTerraBaseDraft);
    const recommendation = liveTerraBaseDraft.email_body.split(/\n\s*\n/).slice(1).join('\n\n').trim();
    expect(s.enriched.rendered.body).toContain(recommendation);
    expect(s.enriched.sections.find((x) => x.kind === 'RECOMMENDATION')!.text).toBe(recommendation);
  });

  it('leaves the Terra-authored subject unchanged', async () => {
    const s = await successOrThrow(liveTerraBaseDraft);
    expect(s.enriched.rendered.subject).toBe(liveTerraBaseDraft.selected_subject);
  });

  it('claim ledger contains only externally rendered claims (each appears in the body; CTA excepted)', async () => {
    const s = await successOrThrow(liveTerraBaseDraft);
    const kinds = s.enriched.ledger.map((e) => e.claimType);
    expect(kinds).toEqual(['PROSPECT_OBSERVATION', 'COMPETITOR_PATTERN', 'RECOMMENDATION', 'CTA']);
    for (const e of s.enriched.ledger) {
      if (e.claimType === 'CTA') continue;
      expect(s.enriched.rendered.body).toContain(e.text);
    }
  });

  it('keeps the contrast + consequence provenance internally traceable even when not rendered', async () => {
    const s = await successOrThrow(liveTerraBaseDraft);
    // The package still holds an approved contrast + consequence label; only their external sentences are omitted.
    expect(s.plan.selection.contrast).not.toBeNull();
    expect(s.plan.selection.pattern.consequenceLabel).toBe('BOOKING_DISCOVERABILITY');
    expect(s.plan.contrastSentence).not.toBeNull();
    expect(s.plan.consequenceSentence).toBe(CONSEQUENCE_TEMPLATES.BOOKING_DISCOVERABILITY);
  });

  it('all hard gates pass, including the new structured_copy_redundancy gate', async () => {
    const s = await successOrThrow(liveTerraBaseDraft);
    const gates = evaluateHardGates(s);
    expect(gates.allPassed).toBe(true);
    expect(gates.gates.find((g) => g.id === 'structured_copy_redundancy')!.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §3 — the decision is STRUCTURAL, not a free-text/semantic guess
// ---------------------------------------------------------------------------

function pattern(over: Partial<EnrichmentPattern> = {}): EnrichmentPattern {
  return {
    patternId: 'p-book', category: 'BOOKING_CTA_VISIBLE', result: 'ALL_OBSERVED', presentCount: 2,
    usableDenominator: 2, confidence: 'HIGH', wordingForm: 'TWO_OF_TWO', wordingText: 'two nearby clinics',
    consequenceLabel: 'BOOKING_DISCOVERABILITY', isDepth: false, evidenceItemIds: ['e1', 'e2'], ...over,
  };
}
function pkg(over: Partial<EnrichmentPackage> = {}): EnrichmentPackage {
  return { packageId: 'pkg1', version: 1, packageHash: 'hash-a', status: 'APPROVED', leadId: 'lead1', patterns: [pattern()], contrasts: [], identityTokens: ['smilecare'], ...over };
}
const bookingFinding: EnrichmentProspectFinding = { evidenceId: 'f1', findingRef: 'F1', category: 'BOOKING_FRICTION' };
const contactFinding: EnrichmentProspectFinding = { evidenceId: 'f2', findingRef: 'F2', category: 'CONTACT_FRICTION' };
function planOk(p: EnrichmentPackage = pkg(), findings: EnrichmentProspectFinding[] = [bookingFinding]): EnrichmentPlan {
  const outcome = planEnrichment({ leadId: 'lead1', language: 'en', package: p, safeFindings: findings, requestedPatternId: null });
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.plan;
}

describe('Phase 7A4B2 — structured render decision (no semantic-regex guessing)', () => {
  it('decideCompetitorRender is driven purely by structural presence flags', () => {
    // Base has an observation AND a recommendation -> only the competitor sentence.
    expect(decideCompetitorRender(true, true, true)).toMatchObject({ renderConsequence: false, renderContrast: false });
    // Base lacks a recommendation -> render the consequence to supply the missing aligned element.
    expect(decideCompetitorRender(true, false, true)).toMatchObject({ renderConsequence: true, renderContrast: false });
    // Base lacks the aligned observation AND a contrast exists -> render the contrast.
    expect(decideCompetitorRender(false, true, true)).toMatchObject({ renderConsequence: false, renderContrast: true });
    // No contrast available -> never render one regardless of the base.
    expect(decideCompetitorRender(false, true, false)).toMatchObject({ renderContrast: false });
  });

  it('two-paragraph base -> one sentence; one-paragraph base -> consequence rendered (structure, not keywords)', () => {
    const plan = planOk();
    // Identical wording in both bases; ONLY the paragraph structure differs, proving no keyword heuristic.
    const twoPara = buildCompositionSections(plan, ['Booking is hard to find here.', 'Raising it near the top would help.']);
    const onePara = buildCompositionSections(plan, ['Booking is hard to find here.']);
    const twoText = twoPara.find((s) => s.kind === 'COMPETITOR_PATTERN')!.text;
    const oneText = onePara.find((s) => s.kind === 'COMPETITOR_PATTERN')!.text;
    expect(twoText).toBe(plan.competitorSentence);
    expect(oneText).toContain(plan.competitorSentence);
    expect(oneText).toContain(plan.consequenceSentence);
    expect(twoText).not.toContain(plan.consequenceSentence);
  });

  it('the ledger tracks exactly the rendered claims for each structure', () => {
    const plan = planOk();
    const twoLedger = buildClaimLedger(plan, buildCompositionSections(plan, ['Obs.', 'Rec.']), pkg());
    const oneLedger = buildClaimLedger(plan, buildCompositionSections(plan, ['Obs.']), pkg());
    expect(twoLedger.map((e) => e.claimType)).toEqual(['PROSPECT_OBSERVATION', 'COMPETITOR_PATTERN', 'RECOMMENDATION']);
    expect(oneLedger.map((e) => e.claimType)).toEqual(['PROSPECT_OBSERVATION', 'COMPETITOR_PATTERN', 'CAUTIOUS_CONSEQUENCE']);
  });
});

// ---------------------------------------------------------------------------
// §4 — category templates: conversational, count-safe, no capability broadening
// ---------------------------------------------------------------------------

describe('Phase 7A4B2 — category templates (count-safe, conversational)', () => {
  it('booking template inserts the exact stored count phrase verbatim and reads conversationally', () => {
    const p = pkg({ patterns: [pattern({ presentCount: 2, usableDenominator: 3, wordingForm: 'TWO_OF_THREE', wordingText: 'two of three comparable nearby clinics' })] });
    const plan = planOk(p);
    expect(plan.competitorSentence).toBe('Two of three comparable nearby clinics make booking available directly from their homepage.');
    for (const term of BANNED) expect(plan.competitorSentence.toLowerCase()).not.toContain(term);
  });

  it('contact-channel templates stay count-safe and conversational', () => {
    const phone = planOk(pkg({ patterns: [pattern({ patternId: 'p-phone', category: 'PHONE_VISIBLE', consequenceLabel: 'CONTACT_DISCOVERABILITY', wordingText: 'both nearby clinics' })] }), [contactFinding]);
    const dm = planOk(pkg({ patterns: [pattern({ patternId: 'p-dm', category: 'WHATSAPP_OR_DIRECT_MESSAGE_VISIBLE', consequenceLabel: 'CONTACT_DISCOVERABILITY', wordingText: 'both nearby clinics' })] }), [contactFinding]);
    expect(phone.competitorSentence).toBe('Both nearby clinics show a direct phone option on their homepage.');
    expect(dm.competitorSentence).toBe('Both nearby clinics offer a direct messaging option on their homepage.');
  });
});

// ---------------------------------------------------------------------------
// §5 — structured redundancy gate
// ---------------------------------------------------------------------------

describe('Phase 7A4B2 — structured redundancy gate', () => {
  const obs: ClaimLedgerEntry = { claimType: 'PROSPECT_OBSERVATION', text: 'Booking is hard to find.', prospectEvidenceIds: ['f1'], patternId: null, contrastId: null, competitorEvidenceIds: [], externallySafe: true };
  const comp: ClaimLedgerEntry = { claimType: 'COMPETITOR_PATTERN', text: 'Both nearby clinics make booking available directly from their homepage.', prospectEvidenceIds: [], patternId: 'p', contrastId: null, competitorEvidenceIds: ['e1'], externallySafe: true };
  const rec: ClaimLedgerEntry = { claimType: 'RECOMMENDATION', text: 'Raising it would help.', prospectEvidenceIds: ['f1'], patternId: null, contrastId: null, competitorEvidenceIds: [], externallySafe: true };
  const cons: ClaimLedgerEntry = { claimType: 'CAUTIOUS_CONSEQUENCE', text: CONSEQUENCE_TEMPLATES.BOOKING_DISCOVERABILITY, prospectEvidenceIds: [], patternId: 'p', contrastId: null, competitorEvidenceIds: [], externallySafe: true };
  const contrast: ClaimLedgerEntry = { claimType: 'PROSPECT_CONTRAST', text: 'Your homepage does not currently include that option.', prospectEvidenceIds: ['cap1'], patternId: 'p', contrastId: 'c1', competitorEvidenceIds: [], externallySafe: true };

  it('passes for the canonical one-sentence flow (obs → competitor → recommendation)', () => {
    expect(detectStructuredRedundancy([obs, comp, rec])).toEqual([]);
  });
  it('fails when a consequence is rendered alongside a base recommendation carrying the same label', () => {
    expect(detectStructuredRedundancy([obs, comp, cons, rec])).toContain('redundant_consequence_with_base_recommendation');
  });
  it('fails when both a contrast and a consequence serve the one approved label', () => {
    expect(detectStructuredRedundancy([obs, comp, contrast, cons])).toContain('redundant_multiple_sentences_same_consequence_label');
  });
  it('fails when a contrast is rendered even though the base already supplies the prospect observation', () => {
    expect(detectStructuredRedundancy([obs, comp, contrast])).toContain('redundant_contrast_repeats_prospect_observation');
  });
});

// ---------------------------------------------------------------------------
// §6 — offline recomposition (zero model calls)
// ---------------------------------------------------------------------------

describe('Phase 7A4B2 — offline recomposition', () => {
  async function mockLiveReport(): Promise<LiveValidationReport> {
    return runLiveValidation({ provider: new MockLlmProvider(defaultMockLiveValidationResponder), config: CONFIG, mode: 'MOCK' });
  }

  it('recomposes a saved report offline to a one-sentence PASS with integrity verified', async () => {
    const report = await mockLiveReport();
    const result = await recomposeLiveValidation(report);
    expect(result.reportHashOk).toBe(true);
    expect(result.determinismHashOk).toBe(true);
    expect(result.hasTerraBaseDraft).toBe(true);
    expect(result.baseDraftMatchesBaseline).toBe(true);
    expect(result.packageHashMatches).toBe(true);
    expect(result.deterministicResult).toBe('PASS');
    expect(result.ok).toBe(true);
    expect(result.competitorSectionAfter!.match(/\./g) ?? []).toHaveLength(1);
    for (const term of BANNED) expect(result.competitorSectionAfter!.toLowerCase()).not.toContain(term);
  });

  it('fails closed on an altered report hash (never trusts a tampered artifact)', async () => {
    const report = await mockLiveReport();
    const result = await recomposeLiveValidation({ ...report, reportHash: '0'.repeat(64) });
    expect(result.reportHashOk).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('fails closed when the saved report carries no Terra base draft', async () => {
    const report = await mockLiveReport();
    const result = await recomposeLiveValidation({ ...report, terraBaseDraft: null });
    expect(result.hasTerraBaseDraft).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('the recompose module + CLI import no network, Gmail, Sheets, draft, send, provider, or database path', () => {
    const sources = [
      '../../src/evaluation/email/live/recompose.ts',
      '../../src/cli/commands/competitor-email-live-validation-recompose.ts',
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

// ---------------------------------------------------------------------------
// §7 — guarded Sol-only re-review (zero Terra; exactly one Sol; require PASS)
// ---------------------------------------------------------------------------

describe('Phase 7A4B2 — Sol-only re-review', () => {
  async function mockLiveReport(): Promise<LiveValidationReport> {
    return runLiveValidation({ provider: new MockLlmProvider(defaultMockLiveValidationResponder), config: CONFIG, mode: 'MOCK' });
  }

  it('reuses the saved Terra draft: makes ZERO Terra calls and EXACTLY ONE Sol call', async () => {
    const source = await mockLiveReport();
    const provider = new MockLlmProvider(defaultMockLiveValidationResponder);
    const report = await runSolOnlyRereview({ provider, config: CONFIG, mode: 'MOCK', source });
    expect(provider.calls.filter((c) => c.task === 'email_write')).toHaveLength(0);
    expect(provider.calls.filter((c) => c.task === 'email_review')).toHaveLength(1);
    expect(provider.calls).toHaveLength(1);
    expect(report.sol.ran).toBe(true);
    expect(report.budget.terraCalls).toBe(0);
    expect(report.budget.solCalls).toBe(1);
    expect(report.sourceReportHash).toBe(source.reportHash);
    expect(report.terraBaseDraft).toEqual(source.terraBaseDraft);
  });

  it('requires deterministic PASS BEFORE Sol — a non-PASS recomposition never calls Sol', async () => {
    const source = await mockLiveReport();
    // Swap in a base draft whose subject carries competitor language → a hard gate fails → deterministic FAIL.
    // terraBaseDraft is excluded from the report hash, so the source stays integrity-valid.
    const badBase: EmailWriterParsed = { ...source.terraBaseDraft!, selected_subject: 'How you compare to competitors' };
    const provider = new MockLlmProvider(defaultMockLiveValidationResponder);
    const report = await runSolOnlyRereview({ provider, config: CONFIG, mode: 'MOCK', source: { ...source, terraBaseDraft: badBase } });
    expect(report.deterministic!.result).not.toBe('PASS');
    expect(report.sol.ran).toBe(false);
    expect(provider.calls).toHaveLength(0); // Sol never called
    expect(report.combinedStatus).toBe('VALIDATION_FAILED');
  });

  it('cannot exceed one Sol call and never retries a malformed response', async () => {
    const source = await mockLiveReport();
    // A malformed Sol response: the orchestrator records one attempt and does NOT retry or fall back.
    const malformedSol: MockResponder = (req) => (req.task === 'email_write' ? { rawJson: {} } : { rawJson: { garbage: true } });
    const provider = new MockLlmProvider(malformedSol);
    const report = await runSolOnlyRereview({ provider, config: CONFIG, mode: 'MOCK', source });
    expect(provider.calls).toHaveLength(1); // exactly one attempt, no retry/fallback
    expect(report.sol.ran).toBe(true);
    expect(report.sol.malformed).toBe(true);
    expect(report.combinedStatus).toBe('REQUIRES_REVISION');
  });

  it('rejects an invalid full source artifact before any call', async () => {
    const source = await mockLiveReport();
    expect(() => requireValidFullSource({ ...source, reportHash: '0'.repeat(64) })).toThrow(RereviewSourceError);
    expect(() => requireValidFullSource({ ...source, terraBaseDraft: null })).toThrow(RereviewSourceError);
    // A valid source returns its Terra base draft.
    expect(requireValidFullSource(source)).toEqual(source.terraBaseDraft);
  });

  it('the re-review module + CLI import no Gmail, Sheets, draft, send, playwright, or database path', () => {
    const sources = [
      '../../src/evaluation/email/live/rereview.ts',
      '../../src/cli/commands/competitor-email-live-validation-rereview.ts',
    ];
    // NB: the re-review DOES make exactly one Sol call, so a provider import/usage is expected and allowed —
    // only outreach side-effect paths (DB/Gmail/Sheets/draft/send) are forbidden.
    const forbiddenImports = [/persistence\/db/, /repositories\//, /\/gmail/i, /sheet/i, /playwright/i, /HttpGmail/, /HttpSheets/, /node:net/];
    const forbiddenUsage = [/\bfetch\s*\(/, /DATABASE_URL/, /new Http/, /createDraft/, /sendExisting/];
    for (const rel of sources) {
      const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
      const importLines = src.split('\n').filter((l) => l.trim().startsWith('import')).join('\n');
      for (const p of forbiddenImports) expect(p.test(importLines), `${rel} imports must not match ${String(p)}`).toBe(false);
      for (const p of forbiddenUsage) expect(p.test(src), `${rel} must not match ${String(p)}`).toBe(false);
    }
  });
});
