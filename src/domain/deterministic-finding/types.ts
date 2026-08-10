import { type AuditCategory } from '../audit/audit-types.js';
import {
  type DeterministicFindingProvenance,
  type DeterministicFindingStatus,
} from './constants.js';

import { type DeterministicEvidenceRow } from './evidence-row.js';

/** Shared capture-evidence row (single source of truth; Layer 1 owns it, bridge re-exports). */
export { type DeterministicEvidenceRow };

/** The latest completed capture run for the lead that approval is evaluated against. */
export interface DeterministicCaptureRunRef {
  id: string;
  completedAt: Date;
  /**
   * The capture's page-selection policy version. Booking-absence findings require a BOOKING-AWARE
   * version (see `booking-discovery.ts`); null/older versions make booking discovery UNKNOWN.
   */
  pageSelectionPolicyVersion: string | null;
}

/**
 * Everything the pure validator needs. All of it is read deterministically from persistence before
 * validation; the validator itself performs no I/O.
 */
export interface DeterministicFindingApprovalInput {
  leadId: string;
  category: string;
  operator: string;
  now: Date;
  /** UUID assigned to the finding by the caller (kept out of the hash; approval stays deterministic). */
  findingId: string;
  /** Exact evidence ids the operator cited, in the order supplied. */
  requestedEvidenceIds: string[];
  /** The latest completed capture run for the lead (null when the lead has no usable capture). */
  captureRun: DeterministicCaptureRunRef | null;
  /** The cited evidence rows actually found in persistence (missing ids simply absent). */
  citedEvidence: DeterministicEvidenceRow[];
  /** ALL evidence rows for `captureRun` — used for the direct-booking-signal absence scan. */
  runEvidence: DeterministicEvidenceRow[];
  /** Categories of the lead's currently-ACTIVE deterministic findings (for duplicate prevention). */
  activeCategories: string[];
}

/** The fully-validated finding, ready to persist. Only produced when validation passes. */
export interface ApprovedDeterministicFinding {
  id: string;
  leadId: string;
  captureRunId: string;
  category: AuditCategory;
  findingRef: string;
  observation: string;
  recommendation: string;
  safeForOutreach: true;
  status: DeterministicFindingStatus;
  provenance: DeterministicFindingProvenance;
  approvedBy: string;
  approvedAt: Date;
  templateVersion: string;
  rulesVersion: string;
  evidenceHash: string;
  evidenceIds: string[];
}

export type DeterministicValidationResult =
  | { ok: true; finding: ApprovedDeterministicFinding }
  | { ok: false; violations: string[] };

/** Projection of an active deterministic finding into the composer's finding shape. */
export interface DeterministicComposerFinding {
  id: string;
  findingRef: string;
  category: AuditCategory;
  safeForOutreach: boolean;
  observation: string;
  recommendation: string;
}
