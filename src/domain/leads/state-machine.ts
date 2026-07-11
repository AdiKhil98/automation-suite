import { InvalidStateTransitionError } from '../../utils/errors.js';
import { LEAD_STATUSES, type LeadStatus } from './status.js';

/**
 * Explicit allowed-transition map for the lead lifecycle. This is the single
 * source of truth; if a transition is not listed here it is invalid.
 *
 * Two rules are applied on top of the base map:
 *  - Any active (non-terminal) state may transition to UNSUBSCRIBED. Suppression
 *    overrides everything, so an unsubscribe can always be recorded.
 *  - Terminal states (below) allow no outgoing transitions.
 */

const TERMINAL: readonly LeadStatus[] = [
  'DUPLICATE',
  'REJECTED_AUTOMATICALLY',
  'REJECTED',
  'UNSUBSCRIBED',
  'FAILED',
  'REPLIED',
  'BOUNCED',
];

const BASE_TRANSITIONS: Record<LeadStatus, LeadStatus[]> = {
  NEW: ['NORMALIZED'],
  NORMALIZED: ['DUPLICATE', 'REJECTED_AUTOMATICALLY', 'READY_FOR_QUALIFICATION'],
  READY_FOR_QUALIFICATION: ['QUALIFIED', 'REJECTED', 'NEEDS_MANUAL_REVIEW'],
  QUALIFIED: ['READY_FOR_AUDIT'],
  READY_FOR_AUDIT: ['AUDITED', 'NEEDS_MANUAL_REVIEW', 'FAILED'],
  AUDITED: ['OPPORTUNITY_READY', 'NEEDS_MANUAL_REVIEW'],
  OPPORTUNITY_READY: ['COMPETITOR_RESEARCH_READY', 'DEMO_DECIDED'],
  COMPETITOR_RESEARCH_READY: ['DEMO_DECIDED'],
  // DEMO_READY only applies when the demo tier is not NONE; both edges are valid.
  DEMO_DECIDED: ['DEMO_READY', 'EMAIL_DRAFTED'],
  DEMO_READY: ['EMAIL_DRAFTED'],
  EMAIL_DRAFTED: ['EMAIL_APPROVED', 'EMAIL_REVIEW_FAILED'],
  // One rewrite cycle only: back to EMAIL_DRAFTED once, else manual review.
  EMAIL_REVIEW_FAILED: ['EMAIL_DRAFTED', 'NEEDS_MANUAL_REVIEW'],
  EMAIL_APPROVED: ['READY_FOR_HUMAN_APPROVAL'],
  READY_FOR_HUMAN_APPROVAL: ['HUMAN_APPROVED', 'REJECTED'],
  HUMAN_APPROVED: ['DRAFT_CREATED'],
  DRAFT_CREATED: ['SENT'],
  SENT: ['REPLIED', 'BOUNCED', 'FAILED'],
  // A lead parked for manual review can be re-accepted or rejected.
  NEEDS_MANUAL_REVIEW: ['READY_FOR_QUALIFICATION', 'READY_FOR_AUDIT', 'REJECTED'],

  // Terminal states — no outgoing transitions.
  DUPLICATE: [],
  REJECTED_AUTOMATICALLY: [],
  REJECTED: [],
  UNSUBSCRIBED: [],
  FAILED: [],
  REPLIED: [],
  BOUNCED: [],
};

function isTerminal(status: LeadStatus): boolean {
  return TERMINAL.includes(status);
}

/** All statuses reachable from `from` in a single legal step. */
export function allowedTransitions(from: LeadStatus): LeadStatus[] {
  const base = BASE_TRANSITIONS[from];
  if (isTerminal(from)) return [...base];
  // Any active state may move to UNSUBSCRIBED (suppression overrides everything).
  return base.includes('UNSUBSCRIBED') ? [...base] : [...base, 'UNSUBSCRIBED'];
}

export function canTransition(from: LeadStatus, to: LeadStatus): boolean {
  return allowedTransitions(from).includes(to);
}

/** Throws {@link InvalidStateTransitionError} if the transition is not allowed. */
export function assertTransition(from: LeadStatus, to: LeadStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidStateTransitionError(from, to);
  }
}

/** Exposed for tests/tools: the full status list plus terminal classification. */
export const stateMachineInfo = {
  statuses: LEAD_STATUSES,
  isTerminal,
};
