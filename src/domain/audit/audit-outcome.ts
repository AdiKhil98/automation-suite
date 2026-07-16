import { type LeadStatus } from '../leads/status.js';
import { type AuditOutcome } from './audit-types.js';

/**
 * Map an audit outcome to a lead-state action. `AUDITED_THEN_OPPORTUNITY` is applied
 * by the service as a two-step transition (AUDITED → OPPORTUNITY_READY). `null` keeps
 * the lead in READY_FOR_AUDIT (transient/budget). Lead-level FAILED is never used for
 * normal model/API failures.
 */
export function routeAuditOutcome(
  outcome: AuditOutcome,
): LeadStatus | 'AUDITED_THEN_OPPORTUNITY' | null {
  switch (outcome) {
    case 'AUDITED':
    case 'AUDITED_NO_ACTIONABLE_FINDINGS':
      return 'AUDITED_THEN_OPPORTUNITY';
    case 'TRANSIENT_PROVIDER_ERROR':
    case 'RATE_LIMITED':
    case 'BUDGET_BLOCKED':
      return null; // remain READY_FOR_AUDIT
    case 'INSUFFICIENT_EVIDENCE':
    case 'CAPTURE_CONFLICT':
    case 'MODEL_REFUSAL':
    case 'SCHEMA_INVALID':
    case 'VALIDATION_FAILED':
    case 'INPUT_TOO_LARGE':
    case 'MANUAL_REVIEW_REQUIRED':
      return 'NEEDS_MANUAL_REVIEW';
  }
}
