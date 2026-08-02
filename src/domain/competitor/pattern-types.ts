/**
 * Phase 7A3A competitor-pattern domain contracts. Pure types shared by the eligibility, logic,
 * wording, confidence, validator, and service modules. No I/O, no AI, no email.
 */

import { type EvidenceCategory } from './evidence-types.js';
import {
  type ConsequenceLabel,
  type ExclusionReason,
  type PackageStatus,
  type PatternConfidence,
  type PatternResult,
  type PresenceState,
  type WordingForm,
} from './pattern-constants.js';

/**
 * One competitor evidence item, flattened for pattern aggregation. Freshness is re-derived from
 * `capturedAt` at evaluation time — the stored status is never trusted on its own.
 */
export interface PatternEvidenceItem {
  id: string;
  captureRunId: string;
  competitorCandidateId: string;
  evidenceCategory: EvidenceCategory;
  observationKind: string;
  confidence: PatternConfidence;
  /** Stored freshness (informational only; the logic recomputes from capturedAt). */
  storedFreshness: string;
  safeForOutreach: boolean;
  active: boolean;
  sourcePageUrl: string;
  numericValue: number | null;
  capturedAt: Date;
  /**
   * PRESENT = the feature was observed. ABSENT = the deterministic detector completed within a defined
   * inspection scope and VERIFIED the feature is absent (an explicit negative observation). Phase 7A2
   * currently emits only PRESENT items — so ABSENT never arises from live data and absence stays
   * UNKNOWN. The mechanism exists so that, if 7A2 later stores scoped negatives, ABSENT is honored.
   */
  polarity: 'PRESENT' | 'ABSENT';
  /** The defined scope a negative observation covers (e.g. "mobile-initial-viewport"); null for PRESENT. */
  inspectionScope: string | null;
}

/**
 * One SELECTED competitor (a distinct branch of a distinct brand) plus its evidence. `selected` and
 * `captureActive` gate participation; `capturedOk` (from the capture run's accessible pages) is what
 * lets us assert a VERIFIED ABSENT rather than UNKNOWN.
 */
export interface PatternCompetitorInput {
  competitorCandidateId: string;
  brandKey: string;
  businessName: string | null;
  parentBrand: string | null;
  /** True iff this candidate was ACCEPTED by the referenced Phase 7A1 research run. */
  selected: boolean;
  /** True iff the owning capture run is DRAFT (not SUPERSEDED). */
  captureActive: boolean;
  /** True iff the competitor's pages were successfully captured (basis for verified absence). */
  capturedOk: boolean;
  evidence: PatternEvidenceItem[];
}

/** One prospect capture-evidence primitive (Phase 5 `capture_evidence`), source-traceable. */
export interface ProspectEvidenceRef {
  id: string;
  evidenceType: string;
  sourceUrl: string | null;
  normalizedValue: string | null;
  profile: 'desktop' | 'mobile';
}

/**
 * An explicit, verified prospect NEGATIVE observation for a mapped category within a defined scope.
 * This — not the mere absence of a low-level primitive — is what permits a prospect ABSENT contrast.
 * Phase 5 prospect capture stores only positive primitives, so this list is empty from live data and
 * contrasts are withheld (UNKNOWN) until an explicit-negative capability exists.
 */
export interface ProspectNegativeObservation {
  category: EvidenceCategory;
  inspectionScope: string;
  evidenceRef: string;
}

/**
 * The prospect's OWN verified evidence. `captureRunId === null` (or `capturedOk === false`) means
 * there is NO verified basis → every prospect state is UNKNOWN → no contrast can be generated. Absence
 * is asserted ONLY via `negatives` (explicit scoped negatives), never inferred from a missing `ref`.
 */
export interface ProspectEvidenceInput {
  leadId: string;
  captureRunId: string | null;
  capturedAt: Date | null;
  capturedOk: boolean;
  refs: ProspectEvidenceRef[];
  negatives: ProspectNegativeObservation[];
}

/** Aggregated, top-level build input for one prospect + one approved research/capture set. */
export interface PatternBuildInput {
  leadId: string;
  researchRunId: string;
  captureRunIds: string[];
  competitors: PatternCompetitorInput[];
  prospect: ProspectEvidenceInput;
  now: Date;
  maxAgeDays: number;
}

/** Per-brand classification for one category (internal, drives the denominator). */
export interface BrandClassification {
  brandKey: string;
  competitorCandidateId: string;
  state: PresenceState;
  /** Eligible evidence item ids for this brand+category (present-supporting). */
  evidenceItemIds: string[];
  /** Highest confidence among the eligible supporting items (null when none). */
  confidence: PatternConfidence | null;
  numericValue: number | null;
}

/** One cross-competitor pattern for a single category. */
export interface CompetitorPattern {
  category: EvidenceCategory;
  result: PatternResult;
  presentCount: number;
  absentCount: number;
  unknownCount: number;
  usableDenominator: number;
  totalSelected: number;
  /** Present-supporting brands' representative candidate ids (exact provenance). */
  participatingCompetitorIds: string[];
  /** Exact competitor evidence item ids backing the present classifications. */
  evidenceItemIds: string[];
  confidence: PatternConfidence;
  wordingForm: WordingForm;
  /** Anonymized, count-bound external wording (null when wordingForm is NONE). */
  wordingText: string | null;
  consequenceLabel: ConsequenceLabel | null;
  /** Median competitor value for depth categories (null for boolean categories). */
  numericMedian: number | null;
  /** All underlying numeric values for depth categories (empty for boolean). */
  numericValues: number[];
  /** True for the two numeric depth categories (never contrasted in 7A3A). */
  isDepth: boolean;
}

/** A boolean prospect-vs-pattern contrast (only for explicitly mapped categories). */
export interface ProspectContrast {
  category: EvidenceCategory;
  contrastKind: 'BOOLEAN';
  prospectState: 'ABSENT';
  /** Source-traceable prospect capture run establishing the verified absence. */
  prospectEvidenceRef: string;
  confidence: PatternConfidence;
  consequenceLabel: ConsequenceLabel;
}

/** An excluded evidence item + reason (auditability). */
export interface EvidenceExclusion {
  evidenceItemId: string;
  competitorCandidateId: string;
  category: EvidenceCategory | null;
  reason: ExclusionReason;
}

/** Exact competitor + prospect evidence references retained with the package. */
export interface PackageEvidenceRef {
  kind: 'COMPETITOR' | 'PROSPECT';
  evidenceItemId: string;
  captureRunId: string | null;
  competitorCandidateId: string | null;
  category: EvidenceCategory | null;
  sourceUrl: string | null;
}

/** The immutable, versioned, source-traceable competitor pattern package (data contract §11). */
export interface CompetitorPatternPackage {
  leadId: string;
  researchRunId: string;
  captureRunIds: string[];
  selectedCompetitorIds: string[];
  eligibleEvidenceCount: number;
  excludedEvidenceCount: number;
  exclusions: EvidenceExclusion[];
  patterns: CompetitorPattern[];
  contrasts: ProspectContrast[];
  evidenceRefs: PackageEvidenceRef[];
  confidence: PatternConfidence;
  freshnessEvaluatedAt: Date;
  rulesVersion: string;
  inputHash: string;
  configHash: string;
  packageHash: string;
  /** Prohibited-claim strings detected (must be empty for an approvable package). */
  prohibitedClaims: string[];
  status: PackageStatus;
}

/** Result of building (dry) or building+persisting (apply) a package. */
export interface PatternRunResult {
  package: CompetitorPatternPackage;
  version: number | null;
  packageRecordId: string | null;
  persisted: boolean;
  reusedExisting: boolean;
}
