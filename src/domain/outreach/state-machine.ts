import { InvalidOutreachTransitionError } from '../../utils/errors.js';
import {
  OUTREACH_NO_FOLLOWUP,
  OUTREACH_STATUSES,
  OUTREACH_TERMINAL,
  type OutreachStatus,
} from './status.js';

/**
 * Explicit allowed-transition map for the outreach lifecycle. This map is the single
 * source of truth: a transition not listed here is invalid and rejected.
 *
 * Two rules are layered on top of the base map:
 *  - From ANY non-terminal state, a genuine suppression signal may always be
 *    recorded: BOUNCED, UNSUBSCRIBED, DO_NOT_CONTACT, and a reply
 *    (REPLIED_POSITIVE / REPLIED_NEUTRAL / REPLIED_NEGATIVE). Reality overrides the
 *    happy path — an unsubscribe or bounce can arrive at any moment.
 *  - Terminal states allow no outgoing transitions.
 */

const HAPPY_PATH: Record<OutreachStatus, OutreachStatus[]> = {
  DRAFT_READY: ['AWAITING_APPROVAL'],
  AWAITING_APPROVAL: ['APPROVED_TO_SEND', 'DRAFT_READY'],
  // INITIAL_SENT records that the initial email was already sent (elsewhere).
  APPROVED_TO_SEND: ['INITIAL_SENT'],
  INITIAL_SENT: ['FOLLOW_UP_1_DUE', 'MEETING_BOOKED', 'CLOSED_LOST'],
  FOLLOW_UP_1_DUE: ['FOLLOW_UP_1_SENT', 'MEETING_BOOKED', 'CLOSED_LOST'],
  FOLLOW_UP_1_SENT: ['FOLLOW_UP_2_DUE', 'MEETING_BOOKED', 'CLOSED_LOST'],
  FOLLOW_UP_2_DUE: ['FOLLOW_UP_2_SENT', 'MEETING_BOOKED', 'CLOSED_LOST'],
  FOLLOW_UP_2_SENT: ['MEETING_BOOKED', 'CLOSED_LOST'],
  // A reply can still convert or die; those edges are human-driven outcome edits.
  REPLIED_POSITIVE: ['MEETING_BOOKED', 'CLOSED_WON', 'CLOSED_LOST'],
  REPLIED_NEUTRAL: ['MEETING_BOOKED', 'CLOSED_WON', 'CLOSED_LOST'],
  REPLIED_NEGATIVE: ['CLOSED_LOST'],
  BOUNCED: [],
  MEETING_BOOKED: ['CLOSED_WON', 'CLOSED_LOST'],
  // Terminal.
  UNSUBSCRIBED: [],
  DO_NOT_CONTACT: [],
  CLOSED_WON: [],
  CLOSED_LOST: [],
};

/**
 * Signals that may interrupt the sequence from any non-terminal state. Ordered so
 * `allowedTransitions` can append the ones not already present.
 */
const INTERRUPTS: readonly OutreachStatus[] = [
  'REPLIED_POSITIVE',
  'REPLIED_NEUTRAL',
  'REPLIED_NEGATIVE',
  'BOUNCED',
  'UNSUBSCRIBED',
  'DO_NOT_CONTACT',
];

export function isOutreachTerminal(status: OutreachStatus): boolean {
  return OUTREACH_TERMINAL.includes(status);
}

/** All statuses reachable from `from` in a single legal step. */
export function allowedOutreachTransitions(from: OutreachStatus): OutreachStatus[] {
  const base = HAPPY_PATH[from];
  if (isOutreachTerminal(from)) return [...base];
  const out = [...base];
  for (const s of INTERRUPTS) {
    if (s !== from && !out.includes(s)) out.push(s);
  }
  return out;
}

export function canOutreachTransition(from: OutreachStatus, to: OutreachStatus): boolean {
  return allowedOutreachTransitions(from).includes(to);
}

/** Throws {@link InvalidOutreachTransitionError} if the transition is not allowed. */
export function assertOutreachTransition(from: OutreachStatus, to: OutreachStatus): void {
  if (!canOutreachTransition(from, to)) {
    throw new InvalidOutreachTransitionError(from, to);
  }
}

/** True when reaching `status` must cancel every pending follow-up for the record. */
export function cancelsFollowups(status: OutreachStatus): boolean {
  return OUTREACH_NO_FOLLOWUP.includes(status);
}

/** Exposed for tests/tools. */
export const outreachStateMachineInfo = {
  statuses: OUTREACH_STATUSES,
  isTerminal: isOutreachTerminal,
};
