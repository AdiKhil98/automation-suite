/**
 * Phase 7A1 competitor-research domain types. Deterministic candidate-selection foundation only —
 * no website capture, no evidence items, no email/package types (those belong to 7A2/7A3).
 */

export type CategoryMatch = 'EXACT' | 'RELATED' | 'WEAK' | 'NONE';
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';
export type Disposition = 'ACCEPTED' | 'REJECTED';
export type ResearchOutcome = 'RESEARCHED' | 'INSUFFICIENT_COMPARABLE' | 'NO_CANDIDATES_FOUND';
export type ActiveRadius = 'PRIMARY_5KM' | 'FALLBACK_10KM';

/** Machine-readable rejection reason codes. Every rejected candidate carries exactly one. */
export const REJECTION_REASONS = [
  'MALFORMED_INPUT',
  'INVALID_WEBSITE',
  'PROSPECT_SELF',
  'PROSPECT_BRANCH',
  'NON_ELIGIBLE_LISTING',
  'DUPLICATE_DOMAIN',
  'DUPLICATE_PROVIDER_ID',
  'DUPLICATE_IDENTITY',
  'MARKET_MISMATCH',
  'WEAK_CATEGORY_MATCH',
  'INSUFFICIENT_SERVICE_OVERLAP',
  'MISSING_COORDINATES',
  'OUT_OF_RADIUS',
  'BELOW_THRESHOLD',
  'LOW_CONFIDENCE',
  'CHAIN_BRANCH_LIMIT',
  'NOT_SELECTED',
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

/** Raw candidate as supplied by a fixture/CSV source (pre-normalization). */
export interface CompetitorInputCandidate {
  rowIndex: number;
  providerCandidateId: string | null;
  businessName: string | null;
  website: string | null;
  primaryCategory: string | null;
  secondaryCategories: string[];
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  city: string | null;
  market: string | null;
  language: string | null;
  businessType: string | null;
  parentBrand: string | null;
  branchId: string | null;
  /** Populated when the source row itself was structurally malformed. */
  malformedReasons?: string[];
}

/** The prospect's operator-supplied comparability attributes + DB-derived identity/coordinates. */
export interface ProspectProfileInput {
  leadId: string;
  website: string | null;
  primaryCategory: string | null;
  secondaryCategories: string[];
  latitude: number | null;
  longitude: number | null;
  city: string | null;
  market: string | null;
  language: string | null;
  businessType: string | null;
  parentBrand: string | null;
}

/** A single persisted score component (one row of the operator-visible breakdown). */
export interface ScoreComponent {
  component: 'CATEGORY' | 'SERVICE_OVERLAP' | 'PROXIMITY' | 'BUSINESS_TYPE' | 'MARKET' | 'LANGUAGE' | 'LOCATION_COUNT';
  points: number;
  maxPoints: number;
  detail: string;
}

/** A single persisted pre-scoring gate outcome. */
export interface GateResult {
  gate: string;
  passed: boolean;
  detail: string;
}

/** Fully evaluated candidate: normalization + gates + score + disposition + reasons. */
export interface EvaluatedCandidate {
  input: CompetitorInputCandidate;
  normalizedDomain: string | null;
  normalizedName: string | null;
  normalizedParentBrand: string | null;
  brandKey: string;
  normalizedPrimaryCategory: string | null;
  normalizedServices: string[];
  distanceMeters: number | null;
  categoryMatch: CategoryMatch | null;
  comparabilityScore: number | null;
  confidence: Confidence | null;
  scoreBreakdown: ScoreComponent[];
  gateResults: GateResult[];
  disposition: Disposition;
  rejectionReason: RejectionReason | null;
  reasonDetail: string;
  acceptanceRank: number | null;
}

/** Result of running deterministic selection over one prospect + candidate set. */
export interface SelectionResult {
  outcome: ResearchOutcome;
  activeRadius: ActiveRadius;
  candidates: EvaluatedCandidate[];
  selected: EvaluatedCandidate[];
  acceptedCount: number;
  rejectedCount: number;
}
