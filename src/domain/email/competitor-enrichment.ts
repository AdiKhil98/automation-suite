/**
 * Phase 7A3B deterministic competitor email enrichment (pure; NO AI, NO I/O, NO network).
 *
 * The model never authors competitor text. Given ONE approved, revalidated competitor pattern package
 * and the prospect's own safe findings, this module:
 *   - enforces MATERIAL alignment between the prospect's primary verified issue and a competitor pattern,
 *   - selects exactly one enrichable pattern by a fixed deterministic order (never "strongest"),
 *   - renders the anonymized competitor sentence + a fixed cautious-consequence template VERBATIM from
 *     approved package metadata (exact stored counts preserved),
 *   - assembles an explicit ordered CompositionPlan (typed sections) that the composer renders from,
 *   - builds a claim ledger with bounded spans for every substantive sentence,
 *   - and validates the FINAL rendered body (supported wording only, no identity leakage, no prohibited
 *     performance/volume/ranking claim, exact count consistency, comparative traceability required).
 *
 * Anything unsupported FAILS closed. Competitor names/domains/raw page text/model competitor prose are
 * never used. No Gmail, Sheets, sending, or website access exists here.
 */

import { type AuditCategory } from '../audit/audit-types.js';
import { type EvidenceCategory } from '../competitor/evidence-types.js';
import {
  CONSEQUENCE_LABELS,
  POSITIVE_PATTERN_RESULTS,
  PROHIBITED_CLAIM_TERMS,
  type ConsequenceLabel,
  type PackageStatus,
  type PatternConfidence,
  type PatternResult,
  type WordingForm,
} from '../competitor/pattern-constants.js';
import { wordingFormFor } from '../competitor/pattern-wording.js';

export const COMPETITOR_ENRICHMENT_RULES_VERSION = 'competitor-email-enrichment-2026-08-03';

export const CLAIM_TYPES = [
  'PROSPECT_OBSERVATION',
  'COMPETITOR_PATTERN',
  'PROSPECT_CONTRAST',
  'CAUTIOUS_CONSEQUENCE',
  'RECOMMENDATION',
  'CTA',
] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

/**
 * Explicit, operator-approved alignment from a prospect audit-finding category to the competitor
 * evidence categories that can materially strengthen the SAME issue. Only categories that also carry a
 * consequence label (see pattern-constants `PROSPECT_CATEGORY_MAPPINGS`) can enrich, so this map covers
 * exactly the booking/contact issues. An unmapped prospect issue can never be enriched.
 */
const AUDIT_TO_EVIDENCE_ALIGNMENT: Partial<Record<AuditCategory, readonly EvidenceCategory[]>> = {
  BOOKING_FRICTION: ['BOOKING_CTA_VISIBLE'],
  CTA_CLARITY: ['BOOKING_CTA_VISIBLE'],
  CONTACT_FRICTION: ['PHONE_VISIBLE', 'WHATSAPP_OR_DIRECT_MESSAGE_VISIBLE'],
};

/** Fixed priority for picking the PRIMARY prospect issue (only enrichable audit categories appear). */
const PRIMARY_ISSUE_PRIORITY: readonly AuditCategory[] = ['BOOKING_FRICTION', 'CONTACT_FRICTION', 'CTA_CLARITY'];

/**
 * Fixed, reviewed cautious-consequence sentence per label. Cautious (never a factual performance,
 * volume, ranking, or revenue claim). A consequence sentence is emitted ONLY from this table, never
 * authored by the model, and never as a raw enum value.
 */
export const CONSEQUENCE_TEMPLATES: Record<ConsequenceLabel, string> = {
  // NB: avoids the word "immediately" so it never collides with the existing fake-urgency copy gate.
  BOOKING_DISCOVERABILITY: 'That may make booking harder for a first-time visitor to find.',
  CONTACT_DISCOVERABILITY: 'That adds another step before a visitor can reach you directly.',
  INFORMATION_ACCESS: 'That places key service information deeper in the current path.',
  NAVIGATION_FRICTION: 'That adds another navigation step to reach the same information.',
  TRUST_INFORMATION_VISIBILITY: 'That places trust information less prominently in the current layout.',
  LOCATION_INFORMATION_ACCESS: 'That places key location information deeper in the current path.',
};

/**
 * Fixed, category-scoped conversational template for the anonymized competitor sentence (§4). Each is
 * factual, anonymized, count-safe (the exact stored `wordingText` count phrase is inserted verbatim),
 * concise, non-accusatory, and free of any performance/volume/ranking claim. Deliberately avoids the word
 * "surface"/"surfaced" — the previous frame read as inserted rubric language. Only the three currently
 * enrichable categories (booking + the two contact channels — those carrying a consequence label and a
 * prospect alignment) have a template; this NEVER broadens evidence capabilities. Location/hours and FAQ
 * templates are documented as future examples but are not aligned/enrichable today, so none is added here.
 */
const COMPETITOR_PATTERN_FRAMES: Partial<Record<EvidenceCategory, (wording: string) => string>> = {
  BOOKING_CTA_VISIBLE: (w) => `${capitalize(w)} make booking available directly from their homepage.`,
  PHONE_VISIBLE: (w) => `${capitalize(w)} show a direct phone option on their homepage.`,
  WHATSAPP_OR_DIRECT_MESSAGE_VISIBLE: (w) => `${capitalize(w)} offer a direct messaging option on their homepage.`,
};

/**
 * Fixed, natural contrast sentence used ONLY in the fallback case where the base draft structurally lacks
 * an aligned prospect observation (see §2/§3). Deliberately avoids the retired mechanical phrasing
 * ("surface"/"surfaced the same way", "on your own site this option…") that Sol flagged. In the current
 * synthetic scenario the base always carries an aligned prospect observation, so this is not rendered.
 */
const CONTRAST_TEMPLATE = 'Your homepage does not currently include that option.';

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

// ---- input contracts (DB-agnostic; the composer maps persisted rows onto these) ----

export interface EnrichmentPattern {
  patternId: string;
  category: EvidenceCategory;
  result: PatternResult;
  presentCount: number;
  usableDenominator: number;
  confidence: PatternConfidence;
  wordingForm: WordingForm;
  wordingText: string | null;
  consequenceLabel: ConsequenceLabel | null;
  isDepth: boolean;
  evidenceItemIds: string[];
}

export interface EnrichmentContrast {
  contrastId: string;
  category: EvidenceCategory;
  consequenceLabel: ConsequenceLabel;
  prospectEvidenceRef: string;
  confidence: PatternConfidence;
}

export interface EnrichmentPackage {
  packageId: string;
  version: number;
  packageHash: string;
  status: PackageStatus;
  leadId: string;
  patterns: EnrichmentPattern[];
  contrasts: EnrichmentContrast[];
  /** Internal competitor identity tokens/domains for the leakage check (never externalized). */
  identityTokens: string[];
}

export interface EnrichmentProspectFinding {
  evidenceId: string;
  findingRef: string;
  category: AuditCategory;
}

export interface EnrichmentRequest {
  leadId: string;
  language: string;
  package: EnrichmentPackage;
  safeFindings: EnrichmentProspectFinding[];
  /** Optional explicit pattern selector (`--competitor-pattern`). Must belong to the package + pass gates. */
  requestedPatternId?: string | null;
}

// ---- outputs ----

export interface CompositionSection {
  kind: ClaimType;
  /** The bounded text span for this section (a sentence or short paragraph). */
  text: string;
}

export interface ClaimLedgerEntry {
  claimType: ClaimType;
  text: string;
  prospectEvidenceIds: string[];
  patternId: string | null;
  contrastId: string | null;
  competitorEvidenceIds: string[];
  externallySafe: boolean;
}

export interface EnrichmentSelection {
  primaryIssue: EnrichmentProspectFinding;
  pattern: EnrichmentPattern;
  contrast: EnrichmentContrast | null;
  /** Machine-readable ranked reasons the pattern was selected (audit trail). */
  selectionReasons: string[];
  alignment: { auditCategory: AuditCategory; evidenceCategory: EvidenceCategory };
}

export interface EnrichmentPlan {
  mode: 'APPROVED_COMPETITOR_PATTERN_PACKAGE';
  selection: EnrichmentSelection;
  competitorSentence: string;
  consequenceSentence: string;
  contrastSentence: string | null;
  rulesVersion: string;
}

export type EnrichmentOutcome =
  | { ok: true; plan: EnrichmentPlan }
  | { ok: false; reason: string };

// ---- eligibility + selection ----

/** A pattern is enrichable iff it is a positive boolean presence pattern with wording + a consequence. */
export function isEnrichablePattern(p: EnrichmentPattern): boolean {
  return (
    !p.isDepth &&
    POSITIVE_PATTERN_RESULTS.has(p.result) &&
    (p.confidence === 'HIGH' || p.confidence === 'MEDIUM') &&
    p.wordingText !== null &&
    p.wordingForm !== 'NONE' &&
    p.consequenceLabel !== null &&
    p.presentCount >= 2 &&
    p.usableDenominator >= 2 &&
    // exact-count wording must be internally consistent with the stored counts.
    p.wordingForm === wordingFormFor(p.presentCount, p.usableDenominator) &&
    COMPETITOR_PATTERN_FRAMES[p.category] !== undefined
  );
}

/** Evidence categories a prospect finding aligns to (empty when the audit category cannot be enriched). */
function alignedEvidenceCategories(auditCategory: AuditCategory): readonly EvidenceCategory[] {
  return AUDIT_TO_EVIDENCE_ALIGNMENT[auditCategory] ?? [];
}

/**
 * Deterministically pick the primary prospect issue: the highest-priority safe finding whose audit
 * category is enrichable AND aligns to at least one enrichable pattern in the package. Ties broken by
 * findingRef then evidenceId. Returns null when no safe finding can be materially enriched.
 */
function selectPrimaryIssue(
  findings: EnrichmentProspectFinding[],
  enrichable: EnrichmentPattern[],
): EnrichmentProspectFinding | null {
  const enrichableCategories = new Set(enrichable.map((p) => p.category));
  const candidates = findings.filter((f) =>
    alignedEvidenceCategories(f.category).some((c) => enrichableCategories.has(c)),
  );
  if (candidates.length === 0) return null;
  const priorityIndex = (c: AuditCategory): number => {
    const i = PRIMARY_ISSUE_PRIORITY.indexOf(c);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...candidates].sort((a, b) =>
    priorityIndex(a.category) - priorityIndex(b.category) ||
    a.findingRef.localeCompare(b.findingRef) ||
    a.evidenceId.localeCompare(b.evidenceId),
  )[0]!;
}

const CONFIDENCE_RANK: Record<PatternConfidence, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const RESULT_RANK: Partial<Record<PatternResult, number>> = { ALL_OBSERVED: 0, MAJORITY_OBSERVED: 1 };

/**
 * Deterministic pattern-selection order (operator amendment #3), applied only to enrichable patterns
 * aligned to the primary issue:
 *   1. pattern has an approved prospect contrast tied to the primary issue's category
 *   2. exact evidence-category match to the primary issue's aligned categories
 *   3. HIGH before MEDIUM
 *   4. ALL_OBSERVED before MAJORITY_OBSERVED
 *   5. larger usable denominator
 *   6. larger present count
 *   7. stable pattern id (final tiebreaker)
 */
function selectPattern(
  aligned: EnrichmentPattern[],
  contrastsByCategory: Map<EvidenceCategory, EnrichmentContrast>,
  primaryEvidenceCategories: readonly EvidenceCategory[],
): { pattern: EnrichmentPattern; reasons: string[] } {
  const primarySet = new Set(primaryEvidenceCategories);
  const hasContrast = (p: EnrichmentPattern): boolean => contrastsByCategory.has(p.category);
  const sorted = [...aligned].sort((a, b) => {
    const ac = hasContrast(a) ? 0 : 1;
    const bc = hasContrast(b) ? 0 : 1;
    if (ac !== bc) return ac - bc;
    const am = primarySet.has(a.category) ? 0 : 1;
    const bm = primarySet.has(b.category) ? 0 : 1;
    if (am !== bm) return am - bm;
    if (CONFIDENCE_RANK[a.confidence] !== CONFIDENCE_RANK[b.confidence]) return CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
    const ar = RESULT_RANK[a.result] ?? 99;
    const br = RESULT_RANK[b.result] ?? 99;
    if (ar !== br) return ar - br;
    if (a.usableDenominator !== b.usableDenominator) return b.usableDenominator - a.usableDenominator;
    if (a.presentCount !== b.presentCount) return b.presentCount - a.presentCount;
    return a.patternId.localeCompare(b.patternId);
  });
  const pattern = sorted[0]!;
  const reasons: string[] = [];
  if (hasContrast(pattern)) reasons.push('has_prospect_contrast_for_primary_issue');
  if (primarySet.has(pattern.category)) reasons.push('exact_category_match_to_primary_issue');
  reasons.push(`confidence_${pattern.confidence}`);
  reasons.push(pattern.result);
  reasons.push(`denominator_${String(pattern.usableDenominator)}`);
  reasons.push(`present_${String(pattern.presentCount)}`);
  return { pattern, reasons };
}

/**
 * Plan an enriched composition, or fail closed with a human-readable reason. Pure and deterministic.
 * Enrichment is limited to English-language leads in 7A3B (the approved anonymized wording is English
 * only); a non-English lead fails closed rather than mixing languages or fabricating a translation.
 */
export function planEnrichment(req: EnrichmentRequest): EnrichmentOutcome {
  if (req.package.status !== 'APPROVED') return { ok: false, reason: `package status is ${req.package.status}, not APPROVED` };
  if (req.package.leadId !== req.leadId) return { ok: false, reason: 'package belongs to a different lead' };
  if (req.language !== 'en') return { ok: false, reason: `competitor enrichment wording is English-only in 7A3B; lead language is ${req.language}` };

  const enrichable = req.package.patterns.filter(isEnrichablePattern);
  if (enrichable.length === 0) return { ok: false, reason: 'package contains no enrichable competitor pattern' };

  const contrastsByCategory = new Map<EvidenceCategory, EnrichmentContrast>();
  for (const c of req.package.contrasts) contrastsByCategory.set(c.category, c);

  const primaryIssue = selectPrimaryIssue(req.safeFindings, enrichable);
  if (!primaryIssue) return { ok: false, reason: 'package contains no materially relevant enrichment for any verified prospect issue' };

  const primaryEvidenceCategories = alignedEvidenceCategories(primaryIssue.category);
  const primarySet = new Set(primaryEvidenceCategories);
  const aligned = enrichable.filter((p) => primarySet.has(p.category));
  if (aligned.length === 0) return { ok: false, reason: 'no competitor pattern aligns with the prospect primary issue' };

  let pattern: EnrichmentPattern;
  let reasons: string[];
  if (req.requestedPatternId) {
    const requested = req.package.patterns.find((p) => p.patternId === req.requestedPatternId);
    if (!requested) return { ok: false, reason: `requested pattern ${req.requestedPatternId} does not belong to the package` };
    if (!isEnrichablePattern(requested)) return { ok: false, reason: `requested pattern ${req.requestedPatternId} is not enrichable` };
    if (!primarySet.has(requested.category)) return { ok: false, reason: `requested pattern ${req.requestedPatternId} does not align with the prospect primary issue` };
    pattern = requested;
    reasons = ['explicit_operator_selection'];
  } else {
    ({ pattern, reasons } = selectPattern(aligned, contrastsByCategory, primaryEvidenceCategories));
  }

  const consequenceLabel = pattern.consequenceLabel!;
  const frame = COMPETITOR_PATTERN_FRAMES[pattern.category]!;
  const competitorSentence = frame(pattern.wordingText!);
  const consequenceSentence = CONSEQUENCE_TEMPLATES[consequenceLabel];
  const contrast = contrastsByCategory.get(pattern.category) ?? null;
  const contrastSentence = contrast ? CONTRAST_TEMPLATE : null;

  return {
    ok: true,
    plan: {
      mode: 'APPROVED_COMPETITOR_PATTERN_PACKAGE',
      selection: {
        primaryIssue,
        pattern,
        contrast,
        selectionReasons: reasons,
        alignment: { auditCategory: primaryIssue.category, evidenceCategory: pattern.category },
      },
      competitorSentence,
      consequenceSentence,
      contrastSentence,
      rulesVersion: COMPETITOR_ENRICHMENT_RULES_VERSION,
    },
  };
}

// ---- structured render decision (§2/§3: one competitor sentence by default) ----

/**
 * Whether the external competitor section should additionally render a contrast and/or a cautious
 * consequence, decided from STRUCTURED base-composition facts (never free-text semantic guessing).
 */
export interface CompetitorRenderDecision {
  /** The base draft carries an aligned prospect observation (its opening structured section). */
  baseHasAlignedProspectObservation: boolean;
  /** The base draft carries an aligned recommendation/consequence (a following structured section). */
  baseHasAlignedRecommendation: boolean;
  /** Render the deterministic prospect-contrast sentence in the competitor section. */
  renderContrast: boolean;
  /** Render the fixed cautious-consequence sentence in the competitor section. */
  renderConsequence: boolean;
}

/**
 * Decide the competitor-section content from structured base facts (§3). By DEFAULT the section contains
 * ONLY the competitor-pattern sentence. A separate consequence is rendered ONLY when the base plan
 * DEMONSTRABLY lacks an aligned recommendation/consequence; a separate contrast ONLY when the base plan
 * demonstrably lacks an aligned prospect observation (and the package actually holds a contrast). When the
 * base already supplies both, the extra sentences are omitted — the contrast/consequence remain available
 * as internal provenance on the plan. If a lack cannot be proven, the extra sentence is omitted (fail-safe).
 */
export function decideCompetitorRender(
  baseHasAlignedProspectObservation: boolean,
  baseHasAlignedRecommendation: boolean,
  hasContrast: boolean,
): CompetitorRenderDecision {
  return {
    baseHasAlignedProspectObservation,
    baseHasAlignedRecommendation,
    renderConsequence: !baseHasAlignedRecommendation,
    renderContrast: hasContrast && !baseHasAlignedProspectObservation,
  };
}

// ---- composition + ledger ----

/**
 * Build the explicit ordered composition sections for the email BODY (greeting/CTA/signoff are added later
 * by the deterministic renderer). Order: prospect observation → competitor section → recommendation. The
 * competitor section holds ONE concise competitor-pattern sentence by default; a contrast/consequence is
 * added only when `decideCompetitorRender` proves the base structurally lacks that aligned element.
 * `prospectParagraphs` are the base (Terra) prospect-only body paragraphs; the base is a single-aligned-issue
 * prospect draft, so its opening paragraph IS the aligned prospect observation and its remainder the aligned
 * recommendation. Presence/absence of those structured sections — not word matching — drives the decision.
 */
export function buildCompositionSections(plan: EnrichmentPlan, prospectParagraphs: string[]): CompositionSection[] {
  const paragraphs = prospectParagraphs.map((p) => p.trim()).filter(Boolean);
  const opening = paragraphs[0] ?? '';
  const recommendation = paragraphs.slice(1).join('\n\n').trim();
  const decision = decideCompetitorRender(opening.length > 0, recommendation.length > 0, plan.contrastSentence !== null);

  const sections: CompositionSection[] = [];
  sections.push({ kind: 'PROSPECT_OBSERVATION', text: opening });

  const competitorParts = [plan.competitorSentence];
  if (decision.renderContrast && plan.contrastSentence) competitorParts.push(plan.contrastSentence);
  if (decision.renderConsequence) competitorParts.push(plan.consequenceSentence);
  sections.push({ kind: 'COMPETITOR_PATTERN', text: competitorParts.join(' ') });

  if (recommendation) sections.push({ kind: 'RECOMMENDATION', text: recommendation });
  return sections;
}

/**
 * Re-derive the competitor-render decision from BUILT sections (structural, not semantic): the presence of a
 * non-empty PROSPECT_OBSERVATION / RECOMMENDATION section reflects exactly the base facts
 * `buildCompositionSections` used, so the ledger, redundancy gate, and final-body validator stay consistent
 * with what was rendered without re-parsing prose.
 */
function decisionFromSections(plan: EnrichmentPlan, sections: CompositionSection[]): CompetitorRenderDecision {
  const opening = sections.find((s) => s.kind === 'PROSPECT_OBSERVATION');
  const recommendation = sections.find((s) => s.kind === 'RECOMMENDATION');
  const hasContrast = plan.contrastSentence !== null && plan.selection.contrast !== null;
  return decideCompetitorRender(
    Boolean(opening && opening.text.trim().length > 0),
    Boolean(recommendation && recommendation.text.trim().length > 0),
    hasContrast,
  );
}

/** Render the enriched email BODY (inner content only) from the composition sections. */
export function renderEnrichedBody(sections: CompositionSection[]): string {
  return sections.map((s) => s.text).join('\n\n');
}

/**
 * Build the claim ledger: bounded spans for every substantive sentence with exact provenance. Competitor
 * claims carry the package/pattern/contrast/competitor-evidence references; the prospect observation
 * carries its finding evidence id. The CTA span is added by the composer (it owns the CTA text).
 */
export function buildClaimLedger(
  plan: EnrichmentPlan,
  sections: CompositionSection[],
  pkg: EnrichmentPackage,
): ClaimLedgerEntry[] {
  const ledger: ClaimLedgerEntry[] = [];
  const primaryEvidenceId = plan.selection.primaryIssue.evidenceId;
  const pattern = plan.selection.pattern;
  const contrast = plan.selection.contrast;
  // The ledger must contain ONLY sentences actually rendered externally (§2). The contrast/consequence
  // provenance is preserved on `plan.selection` regardless of whether their sentences were rendered.
  const decision = decisionFromSections(plan, sections);

  for (const section of sections) {
    if (section.kind === 'PROSPECT_OBSERVATION') {
      ledger.push({
        claimType: 'PROSPECT_OBSERVATION', text: section.text,
        prospectEvidenceIds: [primaryEvidenceId], patternId: null, contrastId: null,
        competitorEvidenceIds: [], externallySafe: true,
      });
    } else if (section.kind === 'COMPETITOR_PATTERN') {
      ledger.push({
        claimType: 'COMPETITOR_PATTERN', text: plan.competitorSentence,
        prospectEvidenceIds: [], patternId: pattern.patternId, contrastId: null,
        competitorEvidenceIds: [...pattern.evidenceItemIds], externallySafe: true,
      });
      if (decision.renderContrast && plan.contrastSentence && contrast) {
        ledger.push({
          claimType: 'PROSPECT_CONTRAST', text: plan.contrastSentence,
          prospectEvidenceIds: [contrast.prospectEvidenceRef], patternId: pattern.patternId, contrastId: contrast.contrastId,
          competitorEvidenceIds: [], externallySafe: true,
        });
      }
      if (decision.renderConsequence) {
        ledger.push({
          claimType: 'CAUTIOUS_CONSEQUENCE', text: plan.consequenceSentence,
          prospectEvidenceIds: [], patternId: pattern.patternId,
          contrastId: contrast?.contrastId ?? null, competitorEvidenceIds: [], externallySafe: true,
        });
      }
    } else if (section.kind === 'RECOMMENDATION') {
      ledger.push({
        claimType: 'RECOMMENDATION', text: section.text,
        prospectEvidenceIds: [primaryEvidenceId], patternId: null, contrastId: null,
        competitorEvidenceIds: [], externallySafe: true,
      });
    }
  }
  void pkg;
  return ledger;
}

// ---- structured redundancy gate (§5: no duplicated approved consequence meaning) ----

/**
 * Deterministic, STRUCTURED redundancy detection (never word-overlap heuristics). It fails when the enriched
 * copy would express the same approved consequence meaning more than once:
 *   1. the competitor section renders a cautious consequence whose label is ALSO represented by the base's
 *      following recommendation/consequence section (the exact Sol-flagged "stated twice" defect);
 *   2. more than one externally rendered competitor-section sentence serves the same approved consequence
 *      label (a rendered contrast + a rendered consequence both carry the pattern's single label);
 *   3. an external contrast is rendered even though the base already supplies the aligned prospect
 *      observation, so the contrast merely repeats the opening observation.
 * Derived purely from the structured claim ledger, so it mirrors exactly what was rendered externally. The
 * base's aligned prospect observation / recommendation are the corresponding structured ledger entries.
 */
export function detectStructuredRedundancy(ledger: ClaimLedgerEntry[]): string[] {
  const violations: string[] = [];
  const nonEmpty = (kind: ClaimType): boolean => ledger.some((e) => e.claimType === kind && e.text.trim().length > 0);
  const baseHasAlignedProspectObservation = nonEmpty('PROSPECT_OBSERVATION');
  const baseHasAlignedRecommendation = nonEmpty('RECOMMENDATION');
  const consequenceRendered = ledger.some((e) => e.claimType === 'CAUTIOUS_CONSEQUENCE');
  const contrastRendered = ledger.some((e) => e.claimType === 'PROSPECT_CONTRAST');

  if (consequenceRendered && baseHasAlignedRecommendation) {
    violations.push('redundant_consequence_with_base_recommendation');
  }
  if (consequenceRendered && contrastRendered) {
    // Contrast and cautious consequence both carry the pattern's single approved consequence label.
    violations.push('redundant_multiple_sentences_same_consequence_label');
  }
  if (contrastRendered && baseHasAlignedProspectObservation) {
    violations.push('redundant_contrast_repeats_prospect_observation');
  }
  return violations;
}

// ---- stable claim spans (body-derived offsets for every substantive claim) ----

export interface ClaimSpan {
  claimType: ClaimType;
  /** The exact claim text this span indexes in the final rendered body. */
  text: string;
  /** 0-based start offset into the final rendered body; -1 when the claim text is not a body substring. */
  start: number;
  /** Exclusive end offset (start + text.length); -1 when not found. */
  end: number;
  /** True iff the body substring [start,end) exactly equals `text` (bounded, verified traceability). */
  valid: boolean;
}

/**
 * Derive stable claim spans from the FINAL rendered body and the claim ledger. Spans follow ledger order,
 * which mirrors body order by construction (prospect observation → competitor / optional contrast /
 * cautious consequence → recommendation). A forward-advancing cursor assigns each claim the FIRST
 * occurrence at or after the previous span's end, so DUPLICATE sentence text maps to distinct, unambiguous
 * offsets rather than collapsing onto the first match. The CTA claim carries a synthetic marker text
 * (`cta:<KIND>`) that is intentionally NOT part of the rendered body and is excluded here.
 *
 * Pure and deterministic: no randomness, no current-timestamp dependency, no locale/timezone formatting.
 * Identical (body, ledger) inputs always yield identical spans.
 */
export function deriveClaimSpans(finalBody: string, ledger: ClaimLedgerEntry[]): ClaimSpan[] {
  const spans: ClaimSpan[] = [];
  let cursor = 0;
  for (const entry of ledger) {
    if (entry.claimType === 'CTA') continue;
    const start = finalBody.indexOf(entry.text, cursor);
    if (start === -1) {
      spans.push({ claimType: entry.claimType, text: entry.text, start: -1, end: -1, valid: false });
      continue;
    }
    const end = start + entry.text.length;
    spans.push({
      claimType: entry.claimType,
      text: entry.text,
      start,
      end,
      // Span validation: confirm the indexed body substring exactly matches the claim text.
      valid: finalBody.slice(start, end) === entry.text,
    });
    cursor = end;
  }
  return spans;
}

/** True only when every derived claim span resolved to an exact bounded body substring. */
export function claimSpansResolved(spans: ClaimSpan[]): boolean {
  return spans.every((s) => s.valid);
}

// ---- final-body validation (defense in depth on the composed artifact) ----

export interface EnrichedValidationResult {
  ok: boolean;
  violations: string[];
}

const IDENTITY_MIN_TOKEN = 4;

/**
 * Validate the FINAL rendered enriched body against the approved package + plan. FAILS (never warns) on:
 * unsupported competitor sentence, identity leakage, prohibited performance/volume/ranking claim, count
 * mismatch, missing comparative traceability, or a comparative sentence not present verbatim in the body.
 */
export function validateEnrichedComposition(
  finalBody: string,
  plan: EnrichmentPlan,
  pkg: EnrichmentPackage,
  ledger: ClaimLedgerEntry[],
): EnrichedValidationResult {
  const violations: string[] = [];
  const lower = finalBody.toLowerCase();
  const pattern = plan.selection.pattern;
  // What was actually rendered externally (§2) — consequence/contrast checks apply only when rendered.
  const consequenceRendered = ledger.some((e) => e.claimType === 'CAUTIOUS_CONSEQUENCE');
  const contrastRendered = ledger.some((e) => e.claimType === 'PROSPECT_CONTRAST');

  // 1. The exact anonymized competitor sentence must appear verbatim in the body.
  if (!finalBody.includes(plan.competitorSentence)) violations.push('competitor_sentence_not_in_body');
  // 2. When rendered, the exact consequence-template sentence must appear verbatim.
  if (consequenceRendered && !finalBody.includes(plan.consequenceSentence)) violations.push('consequence_sentence_not_in_body');
  // 2b. When rendered, the exact contrast sentence must appear verbatim.
  if (contrastRendered && plan.contrastSentence && !finalBody.includes(plan.contrastSentence)) violations.push('contrast_sentence_not_in_body');

  // 3. Exact stored counts preserved: the wording form must match the pattern's counts, and the anonymized
  //    count phrase must be exactly the package's wordingText (no fabricated "two of three").
  // Case-insensitive: the sentence capitalizes the leading letter, but the exact count phrase must be intact.
  if (pattern.wordingText === null || !plan.competitorSentence.toLowerCase().includes(pattern.wordingText.toLowerCase())) {
    violations.push('competitor_count_wording_mismatch');
  }
  if (pattern.wordingForm !== wordingFormFor(pattern.presentCount, pattern.usableDenominator)) {
    violations.push('competitor_count_form_inconsistent');
  }

  // 4. When rendered, the consequence must come from the fixed template table for the pattern's label.
  if (consequenceRendered) {
    const label = pattern.consequenceLabel;
    if (!label || !CONSEQUENCE_LABELS.includes(label)) violations.push('consequence_label_unsupported');
    else if (plan.consequenceSentence !== CONSEQUENCE_TEMPLATES[label]) violations.push('consequence_not_from_template');
  }

  // 4b. Structured redundancy: never express the same approved consequence meaning twice (§5).
  violations.push(...detectStructuredRedundancy(ledger));

  // 5. Identity leakage: no competitor name token (>= 4 chars) or domain may appear in the final body.
  for (const raw of pkg.identityTokens) {
    const tok = raw.toLowerCase().trim();
    if (tok.length < IDENTITY_MIN_TOKEN) continue;
    if (lower.includes(tok)) violations.push(`competitor_identity_leak:${tok}`);
  }

  // 6. Prohibited performance/volume/ranking/revenue claims — hard fail anywhere in the body.
  for (const term of PROHIBITED_CLAIM_TERMS) {
    if (lower.includes(term)) violations.push(`prohibited_claim:${term}`);
  }

  // 7. Comparative traceability: every COMPETITOR_PATTERN / PROSPECT_CONTRAST / CAUTIOUS_CONSEQUENCE
  //    ledger entry must reference a pattern id, and the competitor sentence must cite competitor evidence.
  const comparative = ledger.filter((e) => e.claimType === 'COMPETITOR_PATTERN' || e.claimType === 'PROSPECT_CONTRAST' || e.claimType === 'CAUTIOUS_CONSEQUENCE');
  if (comparative.length === 0) violations.push('missing_comparative_traceability');
  for (const e of comparative) {
    if (!e.patternId) violations.push(`comparative_missing_pattern_ref:${e.claimType}`);
    if (e.claimType === 'COMPETITOR_PATTERN' && e.competitorEvidenceIds.length === 0) violations.push('competitor_claim_missing_evidence_refs');
    if (e.claimType === 'PROSPECT_CONTRAST' && (!e.contrastId || e.prospectEvidenceIds.length === 0)) violations.push('contrast_missing_refs');
  }

  return { ok: violations.length === 0, violations: [...new Set(violations)] };
}
