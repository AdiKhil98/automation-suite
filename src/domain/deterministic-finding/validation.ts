import { type AuditCategory } from '../audit/audit-types.js';
import {
  DETERMINISTIC_FINDING_PROVENANCE,
  DETERMINISTIC_FINDING_RULES_VERSION,
  DETERMINISTIC_FINDING_TEMPLATE_VERSION,
  isCaptureFresh,
} from './constants.js';
import { evaluateCategorySupport } from './evidence-support.js';
import { computeDeterministicFindingHash } from './hash.js';
import { findProhibitedClaims } from './prohibited.js';
import { getDeterministicTemplate, isSupportedDeterministicCategory } from './templates.js';
import {
  type DeterministicEvidenceRow,
  type DeterministicFindingApprovalInput,
  type DeterministicValidationResult,
} from './types.js';

/** Every deterministic finding uses this fixed ref (single finding per lead+category). */
export const DETERMINISTIC_FINDING_REF = 'D1';

/**
 * Deterministic, side-effect-free validation of an operator-approved finding. AI never bypasses this
 * and it never performs I/O — all inputs are read from persistence beforehand. It fails closed:
 * unless EVERY rule passes, no approved finding is produced and `safeForOutreach` is never set.
 *
 * Rules enforced (each maps to a violation code):
 *  - category_unsupported          category has no enabled template/support rule
 *  - no_evidence                   operator cited zero evidence
 *  - no_capture_run                lead has no completed capture run to review
 *  - evidence_missing:<id>         a cited id does not exist
 *  - evidence_foreign:<id>         a cited id belongs to a different lead
 *  - evidence_wrong_run:<id>       a cited id is not part of the reviewed capture run
 *  - capture_stale                 the reviewed capture is older than the freshness window
 *  - direct_booking_signal_present the reviewed capture shows online booking (finding is false)
 *  - booking_discovery_incomplete  bounded booking discovery could not confirm absence (UNKNOWN, not ABSENT)
 *  - booking_intent_absent         no booking-intent control (a "book" control → non-booking page) in the capture
 *  - cited_evidence_not_booking_intent  the operator cited no booking-intent control from this capture
 *  - prohibited_claim:<label>      rendered text contains forbidden wording
 *  - duplicate_active_finding      an ACTIVE finding for this lead+category already exists
 *  - hash_not_reproducible         provenance hash could not be reproduced (defensive)
 */
export function validateDeterministicFinding(
  input: DeterministicFindingApprovalInput,
): DeterministicValidationResult {
  const violations: string[] = [];

  const categorySupported = isSupportedDeterministicCategory(input.category);
  if (!categorySupported) violations.push('category_unsupported');

  const requestedIds = [...new Set(input.requestedEvidenceIds)];
  if (requestedIds.length === 0) violations.push('no_evidence');

  if (!input.captureRun) violations.push('no_capture_run');

  const citedById = new Map<string, DeterministicEvidenceRow>(input.citedEvidence.map((r) => [r.id, r]));
  for (const id of requestedIds) {
    const row = citedById.get(id);
    if (!row) {
      violations.push(`evidence_missing:${id}`);
      continue;
    }
    if (row.leadId !== input.leadId) violations.push(`evidence_foreign:${id}`);
    else if (input.captureRun && row.captureRunId !== input.captureRun.id) violations.push(`evidence_wrong_run:${id}`);
  }

  if (input.captureRun && !isCaptureFresh(input.captureRun.completedAt, input.now)) {
    violations.push('capture_stale');
  }

  // Only evidence that is unambiguously owned by this lead's reviewed run may support the finding.
  const validCited = input.captureRun
    ? requestedIds
        .map((id) => citedById.get(id))
        .filter((r): r is DeterministicEvidenceRow => r !== undefined && r.leadId === input.leadId && r.captureRunId === input.captureRun?.id)
    : [];

  if (categorySupported) {
    const support = evaluateCategorySupport(
      input.category as AuditCategory,
      validCited,
      input.runEvidence,
      input.captureRun?.pageSelectionPolicyVersion ?? null,
    );
    violations.push(...support.violations);
  }

  const template = getDeterministicTemplate(input.category);
  if (template) {
    const prohibited = findProhibitedClaims(`${template.observation} ${template.recommendation}`);
    violations.push(...prohibited.map((label) => `prohibited_claim:${label}`));
  }

  if (input.activeCategories.includes(input.category)) violations.push('duplicate_active_finding');

  if (violations.length > 0 || !template || !input.captureRun) {
    return { ok: false, violations: [...new Set(violations)] };
  }

  const evidenceHash = computeDeterministicFindingHash({
    leadId: input.leadId,
    category: input.category,
    captureRunId: input.captureRun.id,
    evidenceIds: requestedIds,
    templateVersion: DETERMINISTIC_FINDING_TEMPLATE_VERSION,
    rulesVersion: DETERMINISTIC_FINDING_RULES_VERSION,
  });
  // Defensive reproduction check: recompute from the same inputs and confirm it matches.
  const reproduced = computeDeterministicFindingHash({
    leadId: input.leadId,
    category: input.category,
    captureRunId: input.captureRun.id,
    evidenceIds: [...requestedIds].reverse(),
    templateVersion: DETERMINISTIC_FINDING_TEMPLATE_VERSION,
    rulesVersion: DETERMINISTIC_FINDING_RULES_VERSION,
  });
  if (reproduced !== evidenceHash) return { ok: false, violations: ['hash_not_reproducible'] };

  return {
    ok: true,
    finding: {
      id: input.findingId,
      leadId: input.leadId,
      captureRunId: input.captureRun.id,
      category: template.category,
      findingRef: DETERMINISTIC_FINDING_REF,
      observation: template.observation,
      recommendation: template.recommendation,
      safeForOutreach: true,
      status: 'ACTIVE',
      provenance: DETERMINISTIC_FINDING_PROVENANCE,
      approvedBy: input.operator,
      approvedAt: input.now,
      templateVersion: DETERMINISTIC_FINDING_TEMPLATE_VERSION,
      rulesVersion: DETERMINISTIC_FINDING_RULES_VERSION,
      evidenceHash,
      evidenceIds: requestedIds,
    },
  };
}
