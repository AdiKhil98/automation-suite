import { AppError } from '../../utils/errors.js';

/**
 * Phase 3C-A — guarded, read-only KU64 evidence export.
 *
 * This module defines the immutable export contract and the read-only data port.
 * It has NO database, network, rendering, deployment, Gmail, email, or scheduling
 * dependency. The exporter only reads already-stored pipeline evidence for a single
 * approved lead and writes a redacted local JSON snapshot for private V2 preparation.
 */

/** Bumped only when the export payload shape changes. */
export const KU64_EXPORT_SCHEMA_VERSION = 'ku64-evidence-export-1';

/** The only domain this exporter will ever bind to (www variants normalize to this). */
export const KU64_EXPECTED_NORMALIZED_DOMAIN = 'ku64.de';

/**
 * The closed set of per-record source types. Anything outside this set is a bug and
 * the exporter fails closed rather than emit an unknown record type. Notably this set
 * contains NO email/gmail/scheduling/deployment/demo types — those are never exported.
 */
export const KU64_EXPORT_SOURCE_TYPES = [
  'lead',
  'lead_fact',
  'qualification_result',
  'audit_run',
  'audit_finding',
  'audit_review',
  'audit_review_finding',
  'opportunity_assessment',
  'evidence',
  'capture_run',
  'captured_page',
  'capture_evidence',
] as const;

export type Ku64ExportSourceType = (typeof KU64_EXPORT_SOURCE_TYPES)[number];

/** Typed, discriminable error for every fail-closed condition in the exporter. */
export class Ku64ExportError extends AppError {
  constructor(reason: string, message: string) {
    super(`KU64_EXPORT:${reason}`, message);
  }
}

// --- Curated, whitelisted read-model rows -----------------------------------
// Each interface lists ONLY the fields that are safe to export. Raw HTML, page
// bodies, verbatim website text, screenshot binaries/paths, and media URLs are
// intentionally absent so they can never leave the read boundary.

export interface Ku64LeadRow {
  readonly id: string;
  readonly businessName: string | null;
  readonly normalizedName: string | null;
  readonly domain: string | null;
  readonly normalizedDomain: string | null;
  readonly city: string | null;
  readonly country: string | null;
  readonly status: string;
  readonly factsSource: string | null;
  readonly factsSourceUrl: string | null;
  readonly factsCapturedAt: Date | null;
}

export interface Ku64LeadFactRow {
  readonly id: string;
  readonly leadId: string;
  readonly factType: string;
  readonly value: string;
  readonly normalizedValue: string | null;
  readonly sourceType: string;
  readonly sourceUrl: string | null;
  readonly confidence: number;
  readonly capturedAt: Date;
  readonly isCurrent: boolean;
}

export interface Ku64QualificationResultRow {
  readonly id: string;
  readonly leadId: string;
  readonly campaign: string;
  readonly qualificationStage: string;
  readonly rulesVersion: string;
  readonly rulesConfigHash: string;
  readonly decision: string;
  readonly priority: string;
  readonly nextStep: string;
  readonly businessViabilityScore: number | null;
  readonly auditabilityScore: number | null;
  readonly contactabilityScore: number | null;
  readonly opportunityScore: number | null;
  readonly deterministicScore: number | null;
  readonly triggeredRules: unknown;
  readonly missingRequiredFacts: unknown;
  readonly reasons: unknown;
  readonly inputFingerprint: string;
  readonly evaluatedAt: Date;
}

export interface Ku64QualificationResultFactRow {
  readonly qualificationResultId: string;
  readonly leadFactId: string;
}

export interface Ku64AuditRunRow {
  readonly id: string;
  readonly leadId: string;
  readonly captureRunId: string | null;
  readonly outcome: string;
  readonly rubricVersion: string;
  readonly generatorPromptVersion: string;
  readonly reviewerPromptVersion: string;
  readonly schemaVersion: string;
  readonly opportunityRulesVersion: string;
  readonly opportunityRulesHash: string;
  readonly inputFingerprint: string;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
}

export interface Ku64AuditFindingRow {
  readonly id: string;
  readonly auditRunId: string;
  readonly findingRef: string;
  readonly category: string;
  readonly observation: string;
  readonly affectedUrls: unknown;
  readonly affectedProfiles: unknown;
  readonly severity: string;
  readonly confidence: number;
  readonly businessImpact: string;
  readonly recommendation: string;
  readonly safeForOutreach: boolean;
  readonly outreachAngle: string | null;
  readonly uncertainty: string | null;
  readonly reviewDecision: string;
}

export interface Ku64AuditFindingEvidenceRow {
  readonly auditFindingId: string;
  readonly captureEvidenceId: string;
}

export interface Ku64AuditReviewRow {
  readonly id: string;
  readonly auditRunId: string;
  readonly overallDecision: string;
}

export interface Ku64AuditReviewFindingRow {
  readonly id: string;
  readonly auditReviewId: string;
  readonly findingRef: string;
  readonly decision: string;
  readonly evidenceSupported: boolean;
  readonly impactSupported: boolean;
  readonly safeForOutreach: boolean;
  readonly problems: unknown;
  readonly revisedObservation: string | null;
  readonly revisedBusinessImpact: string | null;
  readonly revisedRecommendation: string | null;
  readonly revisedOutreachAngle: string | null;
}

export interface Ku64OpportunityAssessmentRow {
  readonly id: string;
  readonly auditRunId: string;
  readonly leadId: string;
  readonly conversionScore: number;
  readonly mobileScore: number;
  readonly trustScore: number;
  readonly contactabilityScore: number;
  readonly overallScore: number;
  readonly rulesVersion: string;
  readonly rulesHash: string;
  readonly breakdown: unknown;
  readonly capsApplied: unknown;
}

export interface Ku64EvidenceRow {
  readonly id: string;
  readonly leadId: string;
  readonly sourceType: string;
  readonly sourceUrl: string | null;
  readonly claim: string;
  readonly confidence: number;
  readonly selector: string | null;
  readonly capturedAt: Date;
}

export interface Ku64CaptureRunRow {
  readonly id: string;
  readonly leadId: string;
  readonly purpose: string;
  readonly outcome: string;
  readonly primaryUrl: string | null;
  readonly normalizedEvidenceFingerprint: string | null;
  readonly extractorVersion: string | null;
  readonly pageSelectionPolicyVersion: string | null;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
}

export interface Ku64CapturedPageRow {
  readonly id: string;
  readonly captureRunId: string;
  readonly requestedUrl: string;
  readonly finalUrl: string | null;
  readonly canonicalUrl: string | null;
  readonly httpStatus: number | null;
  readonly role: string | null;
  readonly profile: string;
  readonly ok: boolean;
  readonly hasHorizontalOverflow: boolean;
}

export interface Ku64CaptureEvidenceRow {
  readonly id: string;
  readonly capturedPageId: string;
  readonly evidenceType: string;
  readonly sourceUrl: string | null;
  readonly profile: string;
  readonly selector: string | null;
  readonly normalizedValue: string | null;
}

/** The full, already-whitelisted read model for exactly one lead. */
export interface Ku64RawExportData {
  readonly leads: readonly Ku64LeadRow[];
  readonly leadFacts: readonly Ku64LeadFactRow[];
  readonly qualificationResults: readonly Ku64QualificationResultRow[];
  readonly qualificationResultFacts: readonly Ku64QualificationResultFactRow[];
  readonly auditRuns: readonly Ku64AuditRunRow[];
  readonly auditFindings: readonly Ku64AuditFindingRow[];
  readonly auditFindingEvidence: readonly Ku64AuditFindingEvidenceRow[];
  readonly auditReviews: readonly Ku64AuditReviewRow[];
  readonly auditReviewFindings: readonly Ku64AuditReviewFindingRow[];
  readonly opportunityAssessments: readonly Ku64OpportunityAssessmentRow[];
  readonly evidence: readonly Ku64EvidenceRow[];
  readonly captureRuns: readonly Ku64CaptureRunRow[];
  readonly capturedPages: readonly Ku64CapturedPageRow[];
  readonly captureEvidence: readonly Ku64CaptureEvidenceRow[];
}

/**
 * Read-only data port. The only method loads a single lead's already-redacted
 * evidence by exact primary-key id. There is deliberately NO write method on this
 * interface — an implementation cannot mutate anything through it.
 */
export interface Ku64ExportReadPort {
  loadLeadExportData(leadId: string): Promise<Ku64RawExportData>;
}

// --- Immutable export output contract ---------------------------------------

export interface Ku64ExportRecord {
  readonly recordId: string;
  readonly sourceType: Ku64ExportSourceType;
  /** Canonical, whitelisted payload. Never contains `exportedAt`. */
  readonly payload: Record<string, unknown>;
  /** sha256 of the canonical payload alone (deterministic across runs). */
  readonly payloadSha256: string;
}

export interface Ku64EvidenceExport {
  readonly schemaVersion: string;
  readonly leadId: string;
  readonly normalizedDomain: string;
  /** Set OUTSIDE every hashed payload; excluded from all deterministic hashing. */
  readonly exportedAt: string;
  readonly recordCount: number;
  /** Aggregate hash over the stable-sorted records; excludes `exportedAt`. */
  readonly recordsSha256: string;
  readonly records: readonly Ku64ExportRecord[];
}
