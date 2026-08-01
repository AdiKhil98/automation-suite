import { type LeadStatus } from '../leads/status.js';

/**
 * Why a capture ran. Governs targeting rules and routing (see capture-service).
 *
 * `COMPETITOR_CAPTURE` (Phase 7A2) is additive: the lead-bound `CaptureService` and
 * `website_capture_runs` table NEVER produce it. Competitor evidence capture uses its own
 * dedicated, non-lead-bound service + tables (`competitor_capture_runs`). The value is added to
 * the shared `capture_purpose_ck` constraint (additive migration 0030) so the purpose vocabulary
 * is centralized, even though the dedicated competitor tables carry their own purpose column.
 */
export const CAPTURE_PURPOSES = ['AUDIT_CAPTURE', 'VERIFICATION_CAPTURE', 'COMPETITOR_CAPTURE'] as const;
export type CapturePurpose = (typeof CAPTURE_PURPOSES)[number];

/** Capture outcome taxonomy. Lead-level FAILED is NOT part of this set. */
export const CAPTURE_OUTCOMES = [
  'CAPTURED',
  'PARTIAL_CAPTURE',
  'BROWSER_BLOCKED',
  'BOT_CHALLENGE',
  'AUTH_REQUIRED',
  'NO_RENDERABLE_CONTENT',
  'TRANSIENT_ERROR',
  'POLICY_BLOCKED',
  'INVALID_TARGET',
] as const;
export type CaptureOutcome = (typeof CAPTURE_OUTCOMES)[number];

/**
 * AUDIT_CAPTURE routing. Success → CAPTURED (→ READY_FOR_AUDIT, applied as a
 * two-step transition by the service). Transient stays for retry. Everything else
 * routes to manual review. `null` means "no transition" (remain in place).
 */
export function routeAuditCapture(outcome: CaptureOutcome): LeadStatus | 'CAPTURED_THEN_AUDIT' | null {
  switch (outcome) {
    case 'CAPTURED':
    case 'PARTIAL_CAPTURE':
      return 'CAPTURED_THEN_AUDIT';
    case 'TRANSIENT_ERROR':
      return null; // remain READY_FOR_CAPTURE
    case 'BROWSER_BLOCKED':
    case 'BOT_CHALLENGE':
    case 'AUTH_REQUIRED':
    case 'NO_RENDERABLE_CONTENT':
    case 'POLICY_BLOCKED':
    case 'INVALID_TARGET':
      return 'NEEDS_MANUAL_REVIEW';
  }
}
