/**
 * Phase 7A3A cross-competitor pattern logic. Pure, deterministic, fully unit-tested. Computes, for
 * each approved category over the SELECTED competitors of one research run:
 *   - a per-distinct-brand PRESENT / ABSENT / UNKNOWN classification,
 *   - exact counts and a usable denominator (PRESENT + ABSENT only; UNKNOWN never counts),
 *   - a presence pattern result and confidence, plus anonymized count-bound wording,
 *   - a boolean prospect contrast ONLY for explicitly mapped categories with verified prospect ABSENT.
 *
 * Missing data is UNKNOWN, never negative evidence. Depth categories are summarized numerically
 * (median) but never produce a prospect contrast in this milestone. NO AI, NO email, NO network.
 */

import { EVIDENCE_CATEGORIES, type EvidenceCategory } from './evidence-types.js';
import { evaluateFreshness } from './evidence-freshness.js';
import { evaluateCompetitorEvidenceEligibility, prospectShowsPresence } from './pattern-eligibility.js';
import { lowerConfidence, patternConfidence } from './pattern-confidence.js';
import { wordingFormFor, wordingTextFor } from './pattern-wording.js';
import {
  ABSENT_CAPABLE_CATEGORIES,
  DEPTH_CATEGORIES,
  POSITIVE_PATTERN_RESULTS,
  prospectMappingFor,
  type PatternConfidence,
  type PatternResult,
} from './pattern-constants.js';
import {
  type BrandClassification,
  type CompetitorPattern,
  type EvidenceExclusion,
  type PackageEvidenceRef,
  type PatternBuildInput,
  type PatternCompetitorInput,
  type ProspectContrast,
} from './pattern-types.js';

export interface PatternComputation {
  patterns: CompetitorPattern[];
  contrasts: ProspectContrast[];
  exclusions: EvidenceExclusion[];
  eligibleEvidenceIds: string[];
  evidenceRefs: PackageEvidenceRef[];
}

/** Median of a numeric list (average of the two middle values for even length). */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Whether a verified prospect depth is at least one full interaction deeper than the competitor
 * median. Pure and independently tested; NOT wired into package generation in 7A3A (no verified
 * prospect depth is stored), so no depth contrast is ever produced here.
 */
export function depthContrastAllowed(prospectDepth: number | null, competitorDepths: number[]): boolean {
  if (prospectDepth === null || competitorDepths.length < 2) return false;
  const m = median(competitorDepths);
  if (m === null) return false;
  return prospectDepth - m >= 1;
}

/** The strongest confidence among a set (LOW if empty). */
function maxConfidence(confidences: PatternConfidence[]): PatternConfidence {
  let best: PatternConfidence = 'LOW';
  for (const c of confidences) {
    if (c === 'HIGH') return 'HIGH';
    if (c === 'MEDIUM') best = 'MEDIUM';
  }
  return best;
}

interface BrandGroup {
  brandKey: string;
  representativeId: string;
  competitors: PatternCompetitorInput[];
}

/** Group selected+active competitors by distinct brand (one denominator unit per brand). */
function groupByBrand(competitors: PatternCompetitorInput[]): BrandGroup[] {
  const groups = new Map<string, BrandGroup>();
  for (const c of competitors) {
    const existing = groups.get(c.brandKey);
    if (existing) existing.competitors.push(c);
    else groups.set(c.brandKey, { brandKey: c.brandKey, representativeId: c.competitorCandidateId, competitors: [c] });
  }
  return [...groups.values()];
}

/**
 * Classify one brand for one category. PRESENT when an eligible PRESENT-polarity item exists. ABSENT
 * ONLY when the category is ABSENT-capable (verifiable from the bounded capture) AND an eligible,
 * explicit, scoped ABSENT-polarity (negative) observation exists. Everything else — no evidence row,
 * only ineligible items, a negative for a non-ABSENT-capable category, silence, or a bounded/partial
 * capture — is UNKNOWN. "No item found" is NEVER treated as verified absence.
 */
function classifyBrand(
  group: BrandGroup,
  category: EvidenceCategory,
  now: Date,
  maxAgeDays: number,
): BrandClassification {
  const presentIds: string[] = [];
  const presentConfidences: PatternConfidence[] = [];
  const numericValues: number[] = [];
  const absentIds: string[] = [];
  const absentConfidences: PatternConfidence[] = [];
  const absentCapable = ABSENT_CAPABLE_CATEGORIES.has(category);

  for (const competitor of group.competitors) {
    for (const item of competitor.evidence) {
      if (item.evidenceCategory !== category) continue;
      const elig = evaluateCompetitorEvidenceEligibility(competitor, item, now, maxAgeDays);
      if (!elig.eligible) continue;
      if (item.polarity === 'ABSENT') {
        // An explicit negative counts only for an ABSENT-capable category with a defined scope.
        if (absentCapable && item.inspectionScope) {
          absentIds.push(item.id);
          absentConfidences.push(item.confidence);
        }
        continue;
      }
      presentIds.push(item.id);
      presentConfidences.push(item.confidence);
      if (item.numericValue !== null) numericValues.push(item.numericValue);
    }
  }

  if (presentIds.length > 0) {
    return {
      brandKey: group.brandKey,
      competitorCandidateId: group.representativeId,
      state: 'PRESENT',
      evidenceItemIds: presentIds,
      confidence: maxConfidence(presentConfidences),
      numericValue: numericValues.length > 0 ? median(numericValues) : null,
    };
  }
  if (absentIds.length > 0) {
    return {
      brandKey: group.brandKey,
      competitorCandidateId: group.representativeId,
      state: 'ABSENT',
      evidenceItemIds: absentIds,
      confidence: maxConfidence(absentConfidences),
      numericValue: null,
    };
  }
  // No eligible present item and no explicit scoped negative → UNKNOWN (never inferred absence).
  return { brandKey: group.brandKey, competitorCandidateId: group.representativeId, state: 'UNKNOWN', evidenceItemIds: [], confidence: null, numericValue: null };
}

/** Presence-pattern result from exact counts (boolean categories). */
function presenceResult(presentCount: number, denominator: number): PatternResult {
  if (denominator < 2) return 'INSUFFICIENT_DATA';
  if (presentCount < 2) return 'NO_PATTERN';
  if (presentCount / denominator >= 2 / 3) {
    return presentCount === denominator ? 'ALL_OBSERVED' : 'MAJORITY_OBSERVED';
  }
  return 'NO_PATTERN';
}

/** Compute all patterns + contrasts + exclusions for one build input. Pure. */
export function computePatterns(input: PatternBuildInput): PatternComputation {
  const { now, maxAgeDays } = input;
  const selectedActive = input.competitors.filter((c) => c.selected && c.captureActive);
  const brandGroups = groupByBrand(selectedActive);

  const exclusions: EvidenceExclusion[] = [];
  const eligibleEvidenceIds = new Set<string>();
  const evidenceRefs: PackageEvidenceRef[] = [];
  const refSeen = new Set<string>();

  // Record exclusions + eligible ids across ALL competitors (including non-selected, for audit).
  for (const competitor of input.competitors) {
    for (const item of competitor.evidence) {
      const elig = evaluateCompetitorEvidenceEligibility(competitor, item, now, maxAgeDays);
      if (elig.eligible) {
        eligibleEvidenceIds.add(item.id);
      } else if (elig.reason) {
        exclusions.push({ evidenceItemId: item.id, competitorCandidateId: competitor.competitorCandidateId, category: item.evidenceCategory, reason: elig.reason });
      }
    }
  }

  const patterns: CompetitorPattern[] = [];
  const contrasts: ProspectContrast[] = [];

  for (const category of EVIDENCE_CATEGORIES) {
    const isDepth = DEPTH_CATEGORIES.has(category);
    const classifications = brandGroups.map((g) => classifyBrand(g, category, now, maxAgeDays));

    const present = classifications.filter((c) => c.state === 'PRESENT');
    const absent = classifications.filter((c) => c.state === 'ABSENT');
    const unknown = classifications.filter((c) => c.state === 'UNKNOWN');
    const presentCount = present.length;
    const absentCount = absent.length;
    const unknownCount = unknown.length;
    const denominator = presentCount + absentCount;
    const totalSelected = brandGroups.length;

    const evidenceItemIds = present.flatMap((c) => c.evidenceItemIds);
    const participatingCompetitorIds = present.map((c) => c.competitorCandidateId);
    const participatingConfidences = present.map((c) => c.confidence ?? 'LOW');
    const numericValues = present.map((c) => c.numericValue).filter((v): v is number => v !== null);

    // Depth categories: numeric summary only. No positive presence pattern, never contrasted.
    const result: PatternResult = isDepth
      ? denominator < 2
        ? 'INSUFFICIENT_DATA'
        : 'NO_PATTERN'
      : presenceResult(presentCount, denominator);

    const isPositive = !isDepth && POSITIVE_PATTERN_RESULTS.has(result);
    const confidence = isPositive
      ? patternConfidence(denominator, presentCount, participatingConfidences, true)
      : 'LOW';
    const wordingForm = isPositive ? wordingFormFor(presentCount, denominator) : 'NONE';
    const wordingText = isPositive ? wordingTextFor(wordingForm) : null;
    const mapping = prospectMappingFor(category);
    const consequenceLabel = isPositive && mapping ? mapping.consequence : null;

    patterns.push({
      category,
      result,
      presentCount,
      absentCount,
      unknownCount,
      usableDenominator: denominator,
      totalSelected,
      participatingCompetitorIds,
      evidenceItemIds,
      confidence,
      wordingForm,
      wordingText,
      consequenceLabel,
      numericMedian: isDepth ? median(numericValues) : null,
      numericValues: isDepth ? numericValues : [],
      isDepth,
    });

    // Retain exact competitor evidence refs for every classification-backing item (present OR the
    // explicit scoped negatives that back a verified ABSENT), so every denominator unit is traceable.
    for (const c of [...present, ...absent]) {
      for (const id of c.evidenceItemIds) {
        const owner = selectedActive.find((s) => s.evidence.some((e) => e.id === id));
        const ev = owner?.evidence.find((e) => e.id === id);
        const key = `COMPETITOR|${id}`;
        if (ev && !refSeen.has(key)) {
          refSeen.add(key);
          evidenceRefs.push({
            kind: 'COMPETITOR',
            evidenceItemId: id,
            captureRunId: ev.captureRunId,
            competitorCandidateId: ev.competitorCandidateId,
            category,
            sourceUrl: ev.sourcePageUrl,
          });
        }
      }
    }

    // Boolean prospect contrast: only for mapped, non-depth categories with a positive pattern and a
    // VERIFIED prospect ABSENT. Missing prospect capture → UNKNOWN → no contrast (never absence).
    if (isPositive && mapping && !isDepth) {
      const prospectState = classifyProspect(input, category);
      if (prospectState === 'ABSENT' && input.prospect.captureRunId) {
        const contrastConfidence = lowerConfidence(confidence, 'HIGH'); // prospect capture is deterministic (HIGH)
        contrasts.push({
          category,
          contrastKind: 'BOOLEAN',
          prospectState: 'ABSENT',
          prospectEvidenceRef: input.prospect.captureRunId,
          confidence: contrastConfidence,
          consequenceLabel: mapping.consequence,
        });
        const key = `PROSPECT|${input.prospect.captureRunId}|${category}`;
        if (!refSeen.has(key)) {
          refSeen.add(key);
          evidenceRefs.push({
            kind: 'PROSPECT',
            evidenceItemId: input.prospect.captureRunId,
            captureRunId: input.prospect.captureRunId,
            competitorCandidateId: null,
            category,
            sourceUrl: null,
          });
        }
      }
    }
  }

  return {
    patterns,
    contrasts,
    exclusions,
    eligibleEvidenceIds: [...eligibleEvidenceIds].sort(),
    evidenceRefs,
  };
}

/**
 * Prospect state for a mapped category. PRESENT when the mapped proxy primitive is observed. ABSENT
 * ONLY when the prospect evidence system holds an explicit, fresh, verified NEGATIVE observation for
 * the exact mapped category — never inferred from a missing primitive. Everything else is UNKNOWN.
 * Phase 5 prospect capture stores only positive primitives, so `negatives` is empty from live data
 * and contrasts are withheld (UNKNOWN) until an explicit-negative capability exists.
 */
function classifyProspect(input: PatternBuildInput, category: EvidenceCategory): 'PRESENT' | 'ABSENT' | 'UNKNOWN' {
  const mapping = prospectMappingFor(category);
  if (!mapping) return 'UNKNOWN';
  const { prospect } = input;
  if (!prospect.captureRunId || !prospect.capturedOk) return 'UNKNOWN';
  // A verified capture is only usable while fresh.
  if (prospect.capturedAt && evaluateFreshness(prospect.capturedAt, input.now, input.maxAgeDays) !== 'FRESH') return 'UNKNOWN';
  if (prospectShowsPresence(mapping, prospect.refs)) return 'PRESENT';
  // Absence requires an explicit, scoped negative observation — a missing primitive is NOT absence.
  const hasExplicitNegative = prospect.negatives.some((n) => n.category === category && n.inspectionScope.trim() !== '');
  return hasExplicitNegative ? 'ABSENT' : 'UNKNOWN';
}
