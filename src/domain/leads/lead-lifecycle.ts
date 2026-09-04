import { type LeadStatus } from './status.js';

/**
 * Statuses where a NEW decision-maker-discovery / contact-resolution attempt must not begin: outreach
 * is already in flight (drafting/reviewing/scheduled/sent) or the lead has permanently opted out or
 * already replied. Shared by `discover-decision-makers` and `contact-resolve-batch` so both commands
 * agree on which leads are still workable.
 *
 * BOUNCED and FAILED are deliberately NOT included here: BOUNCED means the previously-resolved contact
 * is simply unusable, not that the lead is done — fresh discovery should be able to find a replacement.
 * FAILED (reachable from READY_FOR_ENRICHMENT/READY_FOR_CAPTURE/READY_FOR_AUDIT/SENT) is a technical
 * failure and, by construction of the state machine, is never an opt-out or a reply — those are the
 * separate UNSUBSCRIBED/REPLIED terminal states — so FAILED must not be treated as exhausted either.
 */
const LIFECYCLE_BLOCKED_STATUSES: ReadonlySet<LeadStatus> = new Set<LeadStatus>([
  'REJECTED',
  'REJECTED_AUTOMATICALLY',
  'DUPLICATE',
  'UNSUBSCRIBED',
  'REPLIED',
  'EMAIL_DRAFTED',
  'EMAIL_REVIEW_FAILED',
  'EMAIL_APPROVED',
  'WAITING_FOR_DEMO_URL',
  'FINALIZED_EMAIL_PENDING',
  'READY_FOR_HUMAN_APPROVAL',
  'HUMAN_APPROVED',
  'DRAFT_CREATED',
  'SCHEDULED',
  'SENT',
]);

/**
 * Whether a lead's CURRENT status still permits decision-maker discovery / contact resolution to begin
 * or continue — independent of whether it durably passed qualification (see
 * `PipelineRepository.leadsEverReachedStatus`).
 */
export function isLifecycleEligibleForContactWork(status: LeadStatus): boolean {
  return !LIFECYCLE_BLOCKED_STATUSES.has(status);
}
