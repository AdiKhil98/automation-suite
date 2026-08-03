/**
 * Phase 7A4A — structured baseline-vs-enriched validation report. Separates three layers:
 *   (1) deterministic factual/SAFETY validation (hard gates) — authoritative, blocking,
 *   (2) deterministic QUALITY scoring (the 100-point rubric) — advisory ranking, never overrides (1),
 *   (3) optional future AI critique — not part of 7A4A.
 * A single hard-gate failure forces FAIL regardless of score. The report carries a determinism hash over
 * its stable content so two harness runs produce byte-identical reports.
 */

import { createHash } from 'node:crypto';
import { buildEmailContext } from '../../domain/email/email-render.js';
import { composeEnrichedEmail } from '../../domain/email/competitor-email-composer.js';
import { PRIMARY_CTAS } from '../../domain/email/email-types.js';
import { type ConsequenceLabel } from '../../domain/competitor/pattern-constants.js';
import { evaluateHardGates, type HardGateReport } from './hard-gates.js';
import { type ClaimSpan } from '../../domain/email/competitor-enrichment.js';
import { categoryPoints, scoreEmail, type RubricInput, type RubricScore } from './email-quality-rubric.js';
import { ACCEPTANCE, COMPETITOR_EMAIL_VALIDATION_RULES_VERSION } from './constants.js';
import { type HarnessOutcome, type HarnessSuccess } from './harness.js';

export type ValidationResultKind = 'PASS' | 'REVISE' | 'FAIL';

/** Approved consequence label per aligned evidence category (mirrors PROSPECT_CATEGORY_MAPPINGS). */
const EXPECTED_CONSEQUENCE: Record<string, ConsequenceLabel> = {
  BOOKING_CTA_VISIBLE: 'BOOKING_DISCOVERABILITY',
  PHONE_VISIBLE: 'CONTACT_DISCOVERABILITY',
  WHATSAPP_OR_DIRECT_MESSAGE_VISIBLE: 'CONTACT_DISCOVERABILITY',
};

export interface EmailView {
  subject: string;
  body: string;
  evidenceMode: string;
  schemaVersion: string;
  rubric: RubricScore;
  wordCount: number;
}

export interface ValidationReport {
  rulesVersion: string;
  scenarioLabel: string;
  leadId: string;
  result: ValidationResultKind;
  reasons: string[];
  pipeline: {
    ok: boolean;
    researchOutcome: string | null;
    acceptedCompetitors: number | null;
    captureOutcome: string | null;
    evidenceCount: number | null;
    approvedBy: string | null;
    packageHash: string | null;
    revalidationHashMatched: boolean | null;
  };
  selection: {
    patternId: string | null;
    patternCategory: string | null;
    patternResult: string | null;
    wordingText: string | null;
    consequenceLabel: string | null;
    contrastId: string | null;
    contrastCategory: string | null;
    selectionReasons: string[];
    primaryIssueFindingRef: string | null;
    alignment: string | null;
  };
  evidenceReferences: { competitorEvidenceIds: string[]; prospectEvidenceIds: string[] };
  claimLedger: Array<{ claimType: string; text: string; patternId: string | null; contrastId: string | null; prospectEvidenceIds: string[]; competitorEvidenceIds: string[] }>;
  baseline: EmailView | null;
  enriched: EmailView | null;
  scoreDifference: number | null;
  hardGates: HardGateReport | null;
  lengthComparison: { baselineWords: number | null; enrichedWords: number | null; delta: number | null };
  improvementExplanation: string[];
  awkwardWordingNotes: string[];
  composedMessageHash: string | null;
  /** Bounded, body-derived claim spans for the enriched artifact (null when no enriched email was produced). */
  claimSpans: ClaimSpan[] | null;
  determinismHash: string;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function buildEnrichedRubricInput(result: HarnessSuccess): RubricInput {
  const enriched = result.enriched;
  const plan = result.plan;
  const sections = enriched.sections;
  const ctx = buildEmailContext(result.emailInputs);
  const prospectEntry = enriched.ledger.find((e) => e.claimType === 'PROSPECT_OBSERVATION');
  const competitorEntry = enriched.ledger.find((e) => e.claimType === 'COMPETITOR_PATTERN');
  const ev = enriched.enrichedValidation.violations;
  const recomposed = composeEnrichedEmail({
    prospectDraft: result.baseDraft, emailInputs: result.emailInputs, validationCtx: ctx, plan, pkg: result.enrichmentPackage,
  });
  const alignedCategory = plan.selection.alignment.evidenceCategory;

  return {
    mode: 'APPROVED_COMPETITOR_PATTERN_PACKAGE',
    modelBody: enriched.artifact.email_body,
    renderedBody: enriched.rendered.body,
    subject: enriched.rendered.subject,
    modelParagraphs: enriched.artifact.email_body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean),
    competitorSectionCount: sections.filter((s) => s.kind === 'COMPETITOR_PATTERN').length,
    selectedPatternCategory: plan.selection.pattern.category,
    alignedEvidenceCategories: [alignedCategory],
    consequenceLabelMatches: plan.selection.pattern.consequenceLabel === EXPECTED_CONSEQUENCE[plan.selection.pattern.category],
    contrastPresent: plan.selection.contrast !== null,
    competitorEvidenceCited: Boolean(competitorEntry && competitorEntry.competitorEvidenceIds.length > 0),
    wordingText: plan.selection.pattern.wordingText,
    competitorSentence: plan.competitorSentence,
    consequenceSentence: plan.consequenceSentence,
    recommendationText: sections.find((s) => s.kind === 'RECOMMENDATION')?.text ?? null,
    recommendationCount: sections.filter((s) => s.kind === 'RECOMMENDATION').length,
    ctaValid: (PRIMARY_CTAS as readonly string[]).includes(enriched.artifact.primary_cta),
    prospectEvidenceCited: Boolean(
      prospectEntry && prospectEntry.prospectEvidenceIds.length > 0 &&
      prospectEntry.prospectEvidenceIds.every((id) => ctx.availableEvidenceIds.has(id)) &&
      prospectEntry.prospectEvidenceIds.some((id) => ctx.acceptedFindingIds.has(id)),
    ),
    hashReproducible: recomposed.composedMessageHash === enriched.composedMessageHash,
    packageIntegrityOk: result.revalidationHashMatched,
    ledgerCoversSections: enriched.ledger.length >= sections.length,
    comparativeRefsOk:
      !ev.some((v) => v.startsWith('comparative_missing_pattern_ref')) &&
      !ev.includes('competitor_claim_missing_evidence_refs') &&
      !ev.some((v) => v.startsWith('contrast_missing_refs')),
  };
}

function buildBaselineRubricInput(result: HarnessSuccess): RubricInput {
  const ctx = buildEmailContext(result.emailInputs);
  const baseDraft = result.baseDraft;
  const paras = baseDraft.email_body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const prospectCited =
    baseDraft.evidence_ids.every((id) => ctx.availableEvidenceIds.has(id)) &&
    baseDraft.evidence_ids.some((id) => ctx.acceptedFindingIds.has(id));
  return {
    mode: 'NONE',
    modelBody: baseDraft.email_body,
    renderedBody: result.baseline.body,
    subject: result.baseline.subject,
    modelParagraphs: paras,
    competitorSectionCount: 0,
    selectedPatternCategory: null,
    alignedEvidenceCategories: [],
    consequenceLabelMatches: false,
    contrastPresent: false,
    competitorEvidenceCited: false,
    wordingText: null,
    competitorSentence: null,
    consequenceSentence: null,
    recommendationText: paras[1] ?? null,
    recommendationCount: paras.length >= 2 ? 1 : 0,
    ctaValid: (PRIMARY_CTAS as readonly string[]).includes(baseDraft.primary_cta),
    prospectEvidenceCited: prospectCited,
    hashReproducible: true,
    packageIntegrityOk: !result.baseline.body.includes(result.plan.competitorSentence),
    ledgerCoversSections: true,
    comparativeRefsOk: true,
  };
}

const CATEGORY_LABELS: Record<string, string> = {
  prospectSpecificity: 'Prospect specificity',
  materialRelevance: 'Material relevance',
  integrity: 'Evidence & traceability integrity',
  clarity: 'Clarity & readability',
  brevity: 'Brevity & focus',
  recommendationCta: 'Recommendation & CTA coherence',
  naturalness: 'Naturalness & non-template feel',
};

/** Build the full structured report from a harness outcome (success or typed failure). */
export function buildReport(outcome: HarnessOutcome): ValidationReport {
  const emptyPipeline = {
    ok: false, researchOutcome: null, acceptedCompetitors: null, captureOutcome: null,
    evidenceCount: null, approvedBy: null, packageHash: null, revalidationHashMatched: null,
  };
  if (!outcome.ok) {
    const base: ValidationReport = {
      rulesVersion: COMPETITOR_EMAIL_VALIDATION_RULES_VERSION,
      scenarioLabel: 'SYNTHETIC-DENTAL-BOOKING-DISCOVERABILITY',
      leadId: 'synthetic-lead-northgate-dental',
      result: 'FAIL',
      reasons: [`pipeline failed at ${outcome.failureStage}: ${outcome.reason}`],
      pipeline: emptyPipeline,
      selection: { patternId: null, patternCategory: null, patternResult: null, wordingText: null, consequenceLabel: null, contrastId: null, contrastCategory: null, selectionReasons: [], primaryIssueFindingRef: null, alignment: null },
      evidenceReferences: { competitorEvidenceIds: [], prospectEvidenceIds: [] },
      claimLedger: [], baseline: null, enriched: null, scoreDifference: null, hardGates: null,
      lengthComparison: { baselineWords: null, enrichedWords: null, delta: null },
      improvementExplanation: [], awkwardWordingNotes: [], composedMessageHash: null, claimSpans: null, determinismHash: '',
    };
    base.determinismHash = hashReport(base);
    return base;
  }

  const hardGates = evaluateHardGates(outcome);
  const baselineInput = buildBaselineRubricInput(outcome);
  const enrichedInput = buildEnrichedRubricInput(outcome);
  const baselineScore = scoreEmail(baselineInput);
  const enrichedScore = scoreEmail(enrichedInput);
  const diff = enrichedScore.total - baselineScore.total;

  const plan = outcome.plan;
  const enriched = outcome.enriched;

  const qualityReasons = qualityShortfalls(baselineScore, enrichedScore);
  const { result, reasons } = decideResult(hardGates.allPassed, hardGates.failedIds, qualityReasons);

  const improvementExplanation: string[] = [];
  for (const c of enrichedScore.categories) {
    const b = baselineScore.categories.find((x) => x.category === c.category)!;
    if (c.points > b.points) improvementExplanation.push(`${CATEGORY_LABELS[c.category]}: +${String(c.points - b.points)} (${String(b.points)}→${String(c.points)})`);
  }
  const awkwardWordingNotes: string[] = [];
  for (const c of enrichedScore.categories) {
    if (c.category !== 'naturalness' && c.category !== 'clarity') continue;
    for (const chk of c.checks) if (!chk.pass) awkwardWordingNotes.push(`${CATEGORY_LABELS[c.category]} — ${chk.name} not satisfied`);
  }
  if (awkwardWordingNotes.length === 0) awkwardWordingNotes.push('none — wording reads naturally and within readability bounds');

  const report: ValidationReport = {
    rulesVersion: COMPETITOR_EMAIL_VALIDATION_RULES_VERSION,
    scenarioLabel: outcome.scenarioLabel,
    leadId: outcome.leadId,
    result,
    reasons,
    pipeline: {
      ok: true,
      researchOutcome: outcome.researchOutcome,
      acceptedCompetitors: outcome.acceptedCompetitors,
      captureOutcome: outcome.captureOutcome,
      evidenceCount: outcome.evidenceCount,
      approvedBy: outcome.approvedBy,
      packageHash: outcome.package.packageHash,
      revalidationHashMatched: outcome.revalidationHashMatched,
    },
    selection: {
      patternId: plan.selection.pattern.patternId,
      patternCategory: plan.selection.pattern.category,
      patternResult: plan.selection.pattern.result,
      wordingText: plan.selection.pattern.wordingText,
      consequenceLabel: plan.selection.pattern.consequenceLabel,
      contrastId: plan.selection.contrast?.contrastId ?? null,
      contrastCategory: plan.selection.contrast?.category ?? null,
      selectionReasons: plan.selection.selectionReasons,
      primaryIssueFindingRef: plan.selection.primaryIssue.findingRef,
      alignment: `${plan.selection.alignment.auditCategory} → ${plan.selection.alignment.evidenceCategory}`,
    },
    evidenceReferences: {
      competitorEvidenceIds: [...plan.selection.pattern.evidenceItemIds],
      prospectEvidenceIds: [plan.selection.primaryIssue.evidenceId, ...(plan.selection.contrast ? [plan.selection.contrast.prospectEvidenceRef] : [])],
    },
    claimLedger: enriched.ledger.map((e) => ({
      claimType: e.claimType, text: e.text, patternId: e.patternId, contrastId: e.contrastId,
      prospectEvidenceIds: e.prospectEvidenceIds, competitorEvidenceIds: e.competitorEvidenceIds,
    })),
    baseline: { subject: outcome.baseline.subject, body: outcome.baseline.body, evidenceMode: outcome.baseline.competitorEvidenceUsed, schemaVersion: outcome.baseline.schemaVersion, rubric: baselineScore, wordCount: wordCount(outcome.baseDraft.email_body) },
    enriched: { subject: enriched.rendered.subject, body: enriched.rendered.body, evidenceMode: enriched.artifact.competitor_evidence_used, schemaVersion: enriched.schemaVersion, rubric: enrichedScore, wordCount: wordCount(enriched.artifact.email_body) },
    scoreDifference: diff,
    hardGates,
    lengthComparison: { baselineWords: wordCount(outcome.baseDraft.email_body), enrichedWords: wordCount(enriched.artifact.email_body), delta: wordCount(enriched.artifact.email_body) - wordCount(outcome.baseDraft.email_body) },
    improvementExplanation,
    awkwardWordingNotes,
    composedMessageHash: enriched.composedMessageHash,
    claimSpans: enriched.claimSpans,
    determinismHash: '',
  };
  report.determinismHash = hashReport(report);
  return report;
}

/**
 * Deterministic quality shortfalls for the ENRICHED email (empty = every threshold met). Pure — the
 * exact list the acceptance decision consumes.
 */
export function qualityShortfalls(baseline: RubricScore, enriched: RubricScore): string[] {
  const reasons: string[] = [];
  const diff = enriched.total - baseline.total;
  if (enriched.total < ACCEPTANCE.minTotal) reasons.push(`enriched total ${String(enriched.total)} < ${String(ACCEPTANCE.minTotal)}`);
  if (diff < ACCEPTANCE.minImprovementOverBaseline) reasons.push(`improvement ${String(diff)} < ${String(ACCEPTANCE.minImprovementOverBaseline)}`);
  if (enriched.categories.some((c) => c.points === 0)) reasons.push('a category scored zero');
  if (categoryPoints(enriched, 'integrity') !== ACCEPTANCE.requiredIntegrity) reasons.push(`integrity ${String(categoryPoints(enriched, 'integrity'))} != ${String(ACCEPTANCE.requiredIntegrity)}`);
  if (categoryPoints(enriched, 'materialRelevance') < ACCEPTANCE.minMaterialRelevance) reasons.push(`material relevance ${String(categoryPoints(enriched, 'materialRelevance'))} < ${String(ACCEPTANCE.minMaterialRelevance)}`);
  return reasons;
}

/**
 * Final PASS / REVISE / FAIL decision. SAFETY OVERRIDES SCORE: any hard-gate failure is FAIL regardless
 * of quality. Otherwise unmet quality thresholds are REVISE, and a fully-passing enriched email is PASS.
 */
export function decideResult(
  hardGatesPassed: boolean,
  failedGateIds: string[],
  qualityReasons: string[],
): { result: ValidationResultKind; reasons: string[] } {
  if (!hardGatesPassed) {
    return { result: 'FAIL', reasons: [`hard safety gate(s) failed: ${failedGateIds.join(', ')}`] };
  }
  if (qualityReasons.length === 0) {
    return { result: 'PASS', reasons: ['all hard gates passed; enriched meets every quality threshold'] };
  }
  return { result: 'REVISE', reasons: ['hard gates passed but quality thresholds unmet', ...qualityReasons] };
}

/** Canonical stable-key JSON (arrays kept in order). */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

/** Determinism hash over the report's stable content (excludes the hash field itself). */
export function hashReport(report: ValidationReport): string {
  const { determinismHash: _omit, ...stable } = report;
  return createHash('sha256').update(canonical(stable)).digest('hex');
}

/** Human-readable rendering of the report (used by the run/review CLI). */
export function renderReportText(report: ValidationReport): string {
  const lines: string[] = [];
  lines.push(`# Competitor Email Quality Validation — ${report.scenarioLabel}`);
  lines.push(`rules: ${report.rulesVersion}   result: ${report.result}`);
  for (const r of report.reasons) lines.push(`  • ${r}`);
  if (!report.pipeline.ok) {
    lines.push('\n(pipeline did not complete; no emails produced)');
    lines.push(`\ndeterminism hash: ${report.determinismHash.slice(0, 16)}`);
    return lines.join('\n');
  }
  lines.push('\n## Pipeline');
  lines.push(`  research: ${report.pipeline.researchOutcome}   accepted competitors: ${String(report.pipeline.acceptedCompetitors)}`);
  lines.push(`  capture: ${report.pipeline.captureOutcome}   evidence items: ${String(report.pipeline.evidenceCount)}`);
  lines.push(`  package hash: ${report.pipeline.packageHash?.slice(0, 16)}   approved by: ${report.pipeline.approvedBy}   hash re-matched: ${String(report.pipeline.revalidationHashMatched)}`);
  lines.push('\n## Selection');
  lines.push(`  pattern: ${report.selection.patternCategory} (${report.selection.patternResult})  wording: "${report.selection.wordingText ?? ''}"`);
  lines.push(`  consequence: ${report.selection.consequenceLabel}   contrast: ${report.selection.contrastCategory ?? '(none)'}`);
  lines.push(`  alignment: ${report.selection.alignment}   primary issue: ${report.selection.primaryIssueFindingRef}`);
  lines.push(`  reasons: ${report.selection.selectionReasons.join(' > ')}`);
  lines.push('\n## Baseline (prospect-only)');
  lines.push(`  mode: ${report.baseline!.evidenceMode}   schema: ${report.baseline!.schemaVersion}   words: ${String(report.baseline!.wordCount)}   total: ${String(report.baseline!.rubric.total)}/100`);
  lines.push(`  Subject: ${report.baseline!.subject}`);
  lines.push(indent(report.baseline!.body));
  lines.push('\n## Enriched (approved competitor package)');
  lines.push(`  mode: ${report.enriched!.evidenceMode}   schema: ${report.enriched!.schemaVersion}   words: ${String(report.enriched!.wordCount)}   total: ${String(report.enriched!.rubric.total)}/100`);
  lines.push(`  Subject: ${report.enriched!.subject}`);
  lines.push(indent(report.enriched!.body));
  lines.push('\n## Rubric (baseline → enriched)');
  for (const c of report.enriched!.rubric.categories) {
    const b = report.baseline!.rubric.categories.find((x) => x.category === c.category)!;
    lines.push(`  ${CATEGORY_LABELS[c.category].padEnd(34)} ${String(b.points).padStart(2)} → ${String(c.points).padStart(2)} / ${String(c.max)}`);
  }
  lines.push(`  ${'TOTAL'.padEnd(34)} ${String(report.baseline!.rubric.total).padStart(2)} → ${String(report.enriched!.rubric.total).padStart(2)} / 100   (difference ${String(report.scoreDifference)})`);
  lines.push('\n## Hard safety gates');
  for (const g of report.hardGates!.gates) {
    lines.push(`  [${g.passed ? 'PASS' : 'FAIL'}] ${g.id}${g.detail ? ` — ${g.detail}` : ''}`);
    if (g.diagnostic && !g.passed) {
      const d = g.diagnostic;
      lines.push(`        differing field: ${d.differingField}`);
      lines.push(`        expected hash:   ${d.expectedHash.slice(0, 16)}`);
      lines.push(`        recomputed hash: ${d.recomputedHash.slice(0, 16)}`);
      lines.push(`        body differed: ${String(d.bodyDiffered)}   subject differed: ${String(d.subjectDiffered)}   spans differed: ${String(d.claimSpansDiffered)}   provenance differed: ${String(d.provenanceDiffered)}`);
    }
  }
  lines.push('\n## Claim ledger');
  report.claimLedger.forEach((e, i) => lines.push(`  [${String(i)}] ${e.claimType}: "${e.text.length > 70 ? `${e.text.slice(0, 70)}…` : e.text}"`));
  lines.push('\n## What materially improved');
  for (const s of report.improvementExplanation) lines.push(`  • ${s}`);
  lines.push('\n## Awkward / mechanical wording');
  for (const s of report.awkwardWordingNotes) lines.push(`  • ${s}`);
  lines.push(`\ncomposed message hash: ${report.composedMessageHash?.slice(0, 16)}`);
  lines.push(`determinism hash:      ${report.determinismHash.slice(0, 16)}`);
  return lines.join('\n');
}

function indent(text: string): string {
  return text.split('\n').map((l) => `    ${l}`).join('\n');
}
