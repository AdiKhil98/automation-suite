/**
 * Deterministic outreach-finding bridge — versioned constants (no hidden defaults).
 *
 * A deterministic finding is NOT an AI audit. It is produced when an operator approves an
 * evidence-backed, template-constrained observation about a lead whose AI audit did not yield an
 * outreach-safe finding. Every value here is operator-approved and encoded in code; the versions
 * below are persisted on every finding so any historical outreach is reproducible against the exact
 * rules/template that produced it. Changing any rule/template REQUIRES bumping the matching version.
 */

/**
 * Bumped whenever a validation/support/denylist rule below changes. Persisted per finding.
 * det-find-2: BOOKING_FRICTION support now anchors on a booking-intent control (a "book"-labelled
 * control routing to a non-booking page) that the operator must cite, instead of the earlier passive
 * "phone/email path present" assumption. Booking-aware NO_ONLINE_BOOKING / direct-booking=0 unchanged.
 */
export const DETERMINISTIC_FINDING_RULES_VERSION = 'det-find-2';

/**
 * Bumped whenever a fixed observation/recommendation template changes. Persisted per finding.
 * det-tmpl-2: BOOKING_FRICTION wording reworded to describe booking controls leading to a contact
 * page rather than the phone/email-reliance phrasing of det-tmpl-1.
 */
export const DETERMINISTIC_FINDING_TEMPLATE_VERSION = 'det-tmpl-2';

/**
 * The ONLY provenance value a deterministic finding may carry. It is deliberately distinct from any
 * AI/reviewer provenance: a deterministic finding is never AI-generated and never reviewer-approved.
 */
export const DETERMINISTIC_FINDING_PROVENANCE = 'DETERMINISTIC_OPERATOR_APPROVED' as const;
export type DeterministicFindingProvenance = typeof DETERMINISTIC_FINDING_PROVENANCE;

/** Active/superseded lifecycle for a deterministic finding row. Never AI outcome taxonomy. */
export const DETERMINISTIC_FINDING_STATUSES = ['ACTIVE', 'SUPERSEDED'] as const;
export type DeterministicFindingStatus = (typeof DETERMINISTIC_FINDING_STATUSES)[number];

/**
 * Evidence freshness window for deterministic approval. A deterministic finding may only be approved
 * from a capture no older than this; on/after the boundary the capture is STALE and approval fails
 * closed. Owned here (not shared with the competitor window) so this policy is versioned independently.
 */
export const DETERMINISTIC_EVIDENCE_MAX_AGE_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole-day age of a capture at `now` (floored). Deterministic; never trusts a stored flag. */
export function captureAgeInDays(capturedAt: Date, now: Date): number {
  return Math.floor((now.getTime() - capturedAt.getTime()) / MS_PER_DAY);
}

/** Capture is FRESH strictly before the max-age boundary; on/after it is STALE. */
export function isCaptureFresh(capturedAt: Date, now: Date, maxAgeDays: number = DETERMINISTIC_EVIDENCE_MAX_AGE_DAYS): boolean {
  return captureAgeInDays(capturedAt, now) < maxAgeDays;
}
