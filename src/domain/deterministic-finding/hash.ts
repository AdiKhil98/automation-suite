import { hashCanonical } from '../../utils/hash.js';

/**
 * Deterministic provenance hash for an approved finding. Computed over the identity-defining inputs
 * only (sorted evidence ids so ordering never changes the hash). It is stored on the finding and can
 * be recomputed from the stored fields to prove the finding was produced by the recorded rules —
 * approval fails closed if a recomputation does not reproduce it.
 */
export interface DeterministicFindingHashInput {
  leadId: string;
  category: string;
  captureRunId: string;
  evidenceIds: string[];
  templateVersion: string;
  rulesVersion: string;
}

export function computeDeterministicFindingHash(input: DeterministicFindingHashInput): string {
  return hashCanonical({
    leadId: input.leadId,
    category: input.category,
    captureRunId: input.captureRunId,
    evidenceIds: [...input.evidenceIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    templateVersion: input.templateVersion,
    rulesVersion: input.rulesVersion,
  });
}
