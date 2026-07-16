export const AUDIT_CATEGORIES = [
  'CTA_CLARITY',
  'BOOKING_FRICTION',
  'CONTACT_FRICTION',
  'MOBILE_USABILITY',
  'SERVICE_CLARITY',
  'TRUST_SIGNALS',
  'SOCIAL_PROOF',
  'NAVIGATION',
  'READABILITY',
  'LOCAL_INFORMATION',
  'VISUAL_HIERARCHY',
  'TECHNICAL_RENDERING',
  'ACCESSIBILITY_INDICATOR',
  'DESKTOP_MOBILE_CONSISTENCY',
  'OTHER',
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const PROFILES = ['DESKTOP', 'MOBILE'] as const;
export type AuditProfile = (typeof PROFILES)[number];

/** Generator finding — uses a TEMPORARY call-local ref, never a DB id (amendment 6). */
export interface GeneratorFinding {
  findingRef: string; // e.g. "F1"
  category: AuditCategory;
  observation: string;
  evidenceIds: string[];
  affectedUrls: string[];
  affectedProfiles: AuditProfile[];
  severity: Severity;
  confidence: number;
  businessImpact: string;
  recommendation: string;
  safeForOutreach: boolean;
  outreachAngle: string | null;
  uncertainty: string | null;
}

export interface AuditGeneratorOutput {
  summary: string;
  findings: GeneratorFinding[];
  insufficientEvidenceAreas: string[];
  conflictingEvidence: string[];
  captureLimitations: string[];
}

export type ReviewDecision = 'APPROVE' | 'REVISE' | 'REJECT';

export interface FindingReview {
  findingRef: string;
  decision: ReviewDecision;
  evidenceSupported: boolean;
  impactSupported: boolean;
  safeForOutreach: boolean;
  problems: string[];
  revisedObservation: string | null;
  revisedBusinessImpact: string | null;
  revisedRecommendation: string | null;
  revisedOutreachAngle: string | null;
}

export type OverallReviewDecision = 'APPROVE' | 'APPROVE_WITH_REVISIONS' | 'REJECT' | 'MANUAL_REVIEW';

export interface AuditReviewOutput {
  findings: FindingReview[];
  overallDecision: OverallReviewDecision;
}

/** Final accepted finding after deterministic validation + review (gets a DB UUID). */
export interface AcceptedFinding {
  id: string;
  findingRef: string;
  category: AuditCategory;
  observation: string;
  evidenceIds: string[];
  affectedUrls: string[];
  affectedProfiles: AuditProfile[];
  severity: Severity;
  confidence: number;
  businessImpact: string;
  recommendation: string;
  safeForOutreach: boolean;
  outreachAngle: string | null;
  uncertainty: string | null;
  reviewDecision: ReviewDecision;
}

/** Full audit-run outcome taxonomy. Lead-level FAILED is NOT part of this set. */
export const AUDIT_OUTCOMES = [
  'AUDITED',
  'AUDITED_NO_ACTIONABLE_FINDINGS',
  'INSUFFICIENT_EVIDENCE',
  'CAPTURE_CONFLICT',
  'MODEL_REFUSAL',
  'SCHEMA_INVALID',
  'VALIDATION_FAILED',
  'INPUT_TOO_LARGE',
  'TRANSIENT_PROVIDER_ERROR',
  'RATE_LIMITED',
  'BUDGET_BLOCKED',
  'MANUAL_REVIEW_REQUIRED',
] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export const MAX_FINDINGS = 5;
export const MAX_OUTREACH_SAFE_FINDINGS = 3;
