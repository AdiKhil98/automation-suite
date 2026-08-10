import { type AuditCategory } from '../audit/audit-types.js';
import { type BookingDiscoveryResult, discoverBooking } from './booking-discovery.js';
import { type DeterministicEvidenceRow } from './types.js';

export interface SupportOutcome {
  /** true only when evidence positively supports the category AND no disqualifying signal exists. */
  supported: boolean;
  violations: string[];
  /** Evidence ids that positively support the category (for traceability). */
  supportingEvidenceIds: string[];
  /** Evidence ids that carry a disqualifying direct-booking signal (empty when clean). */
  disqualifyingEvidenceIds: string[];
  /** The bounded booking-discovery result (searched scope) when this category ran it; null otherwise. */
  bookingDiscovery: BookingDiscoveryResult | null;
}

/**
 * BOOKING_FRICTION support (det-find-2). Positive support is anchored on a booking-INTENT control —
 * a "book"-labelled control whose destination is a non-booking page — rather than the earlier passive
 * "phone/email path present" assumption. Every check below must pass:
 *
 *  - bounded, booking-aware discovery concluded NO_ONLINE_BOOKING (this single status subsumes
 *    "booking-aware discovery completed" AND "direct-booking signals = 0"). A positive direct signal
 *    yields `direct_booking_signal_present`; an incomplete/non-booking-aware capture yields
 *    `booking_discovery_incomplete` (UNKNOWN, fail-closed) — absence is never assumed.
 *  - at least one booking-intent control exists in the reviewed capture, else `booking_intent_absent`.
 *  - the operator cited at least one of those intent controls from this capture, tying the finding's
 *    cited evidence to its positive support, else `cited_evidence_not_booking_intent`. (Cited-evidence
 *    lead/run ownership is already enforced by the validator before this runs.)
 *
 * Phone/email presence is no longer required for eligibility (dropped in det-find-2).
 */
function supportBookingFriction(
  citedEvidence: DeterministicEvidenceRow[],
  runEvidence: DeterministicEvidenceRow[],
  pageSelectionPolicyVersion: string | null,
): SupportOutcome {
  const violations: string[] = [];

  const discovery = discoverBooking(runEvidence, pageSelectionPolicyVersion);
  if (discovery.status === 'ONLINE_BOOKING_FOUND') violations.push('direct_booking_signal_present');
  else if (discovery.status === 'UNKNOWN') violations.push('booking_discovery_incomplete');

  const intentIds = new Set(discovery.intentSignals.map((s) => s.evidenceId));
  const citedIntent = citedEvidence.filter((r) => intentIds.has(r.id));
  if (discovery.intentSignals.length === 0) violations.push('booking_intent_absent');
  else if (citedIntent.length === 0) violations.push('cited_evidence_not_booking_intent');

  return {
    supported: violations.length === 0,
    violations,
    supportingEvidenceIds: citedIntent.map((r) => r.id),
    disqualifyingEvidenceIds: discovery.signals.map((s) => s.evidenceId),
    bookingDiscovery: discovery,
  };
}

type SupportChecker = (
  citedEvidence: DeterministicEvidenceRow[],
  runEvidence: DeterministicEvidenceRow[],
  pageSelectionPolicyVersion: string | null,
) => SupportOutcome;

const SUPPORT_CHECKERS: Readonly<Partial<Record<AuditCategory, SupportChecker>>> = {
  BOOKING_FRICTION: supportBookingFriction,
};

/**
 * Evaluate whether the cited/run evidence supports the given category. Returns `supported=false`
 * with `category_unsupported` when the category has no deterministic support rule.
 */
export function evaluateCategorySupport(
  category: AuditCategory,
  citedEvidence: DeterministicEvidenceRow[],
  runEvidence: DeterministicEvidenceRow[],
  pageSelectionPolicyVersion: string | null,
): SupportOutcome {
  const checker = SUPPORT_CHECKERS[category];
  if (!checker) {
    return { supported: false, violations: ['category_unsupported'], supportingEvidenceIds: [], disqualifyingEvidenceIds: [], bookingDiscovery: null };
  }
  return checker(citedEvidence, runEvidence, pageSelectionPolicyVersion);
}
