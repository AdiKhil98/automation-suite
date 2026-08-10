import { type AuditCategory } from '../audit/audit-types.js';
import { DETERMINISTIC_FINDING_PROVENANCE } from './constants.js';
import { type DeterministicComposerFinding } from './types.js';

/**
 * Provenance a composer input can carry. Deliberately explicit so downstream code (and the
 * outreach-compose-preview print-out) can distinguish an AI audit finding from a deterministic,
 * operator-approved one. `AI` is used for anything sourced from the Phase-6 audit pipeline.
 */
export type ComposerFindingSource = 'AI' | typeof DETERMINISTIC_FINDING_PROVENANCE;

/** The minimal finding shape the email composer designs around (matches ComposerAuditFinding). */
export interface ComposerFinding {
  id: string;
  findingRef: string;
  category: AuditCategory;
  safeForOutreach: boolean;
  observation: string;
  recommendation: string;
}

export interface AiComposerAudit {
  auditRunId: string;
  opportunityScore: number | null;
  findings: ComposerFinding[];
}

export interface ResolvedComposerFindings {
  /** null when neither an AI safe finding nor a deterministic finding is available. */
  source: ComposerFindingSource | null;
  auditRunId: string | null;
  opportunityScore: number | null;
  findings: ComposerFinding[];
}

/**
 * Resolve which findings feed the composer, with AI taking precedence.
 *
 *  - If a Phase-6 audit exists AND has ≥1 outreach-safe finding, use it unchanged (source `AI`). The
 *    deterministic bridge never overrides or dilutes a real AI audit.
 *  - Otherwise, if the lead has ACTIVE deterministic findings, project them (source
 *    `DETERMINISTIC_OPERATOR_APPROVED`). This is the fallback that unblocks a lead whose AI audit
 *    produced no safe finding (e.g. a VALIDATION_FAILED run).
 *  - Otherwise there is nothing to compose from (source null).
 *
 * Pure: no I/O, no mutation of inputs.
 */
export function resolveComposerFindings(
  ai: AiComposerAudit | null,
  deterministic: DeterministicComposerFinding[],
): ResolvedComposerFindings {
  if (ai && ai.findings.some((f) => f.safeForOutreach)) {
    return { source: 'AI', auditRunId: ai.auditRunId, opportunityScore: ai.opportunityScore, findings: ai.findings };
  }
  if (deterministic.length > 0) {
    return {
      source: DETERMINISTIC_FINDING_PROVENANCE,
      auditRunId: null,
      opportunityScore: null,
      findings: deterministic.map((f) => ({
        id: f.id,
        findingRef: f.findingRef,
        category: f.category,
        safeForOutreach: f.safeForOutreach,
        observation: f.observation,
        recommendation: f.recommendation,
      })),
    };
  }
  return { source: null, auditRunId: null, opportunityScore: null, findings: [] };
}
