import {
  type EvidenceObservation,
  type FreshnessStatus,
  type WithholdingReason,
} from './evidence-types.js';

/**
 * Deterministic finalization of a single observation: decides withholding, safe-for-outreach, and
 * active status. Only HIGH/MEDIUM, non-inferred, non-withheld, FRESH observations are safe for
 * outreach. UNSUPPORTED_INFERENCE (performance/volume/ranking) is blocked by construction here — it
 * can never be active or safe, regardless of confidence.
 */
export interface Finalized {
  withholdingReason: WithholdingReason | null;
  safeForOutreach: boolean;
  active: boolean;
}

export function finalizeObservation(obs: EvidenceObservation, freshness: FreshnessStatus): Finalized {
  // 1. Unsupported inference is always blocked (defense in depth before any confidence check).
  if (obs.observationKind === 'UNSUPPORTED_INFERENCE') {
    return { withholdingReason: 'PERFORMANCE_INFERENCE', safeForOutreach: false, active: false };
  }
  // 2. A detector-supplied withholding reason (e.g. AMBIGUOUS) wins.
  if (obs.withholdingReason) {
    return { withholdingReason: obs.withholdingReason, safeForOutreach: false, active: false };
  }
  // 3. LOW confidence is never usable.
  if (obs.confidence === 'LOW') {
    return { withholdingReason: 'LOW_CONFIDENCE', safeForOutreach: false, active: false };
  }
  // 4. Active HIGH/MEDIUM observation. Safe only while FRESH; STALE stays active (historical) but unusable.
  if (freshness !== 'FRESH') {
    return { withholdingReason: null, safeForOutreach: false, active: true };
  }
  return { withholdingReason: null, safeForOutreach: true, active: true };
}
