/**
 * Phase 17A outreach lifecycle statuses. This is a SEPARATE state machine from the
 * lead lifecycle (`src/domain/leads/status.ts`): a single lead may run in multiple
 * campaigns, and each (lead × campaign × contact) has its own outreach state here.
 *
 * Tracking only — no status in Phase 17A performs any external action. Advancing to
 * a *_SENT status merely records that a send already happened elsewhere; nothing in
 * this module ever calls Gmail or sends email.
 */

export const OUTREACH_STATUSES = [
  'DRAFT_READY',
  'AWAITING_APPROVAL',
  'APPROVED_TO_SEND',
  'INITIAL_SENT',
  'FOLLOW_UP_1_DUE',
  'FOLLOW_UP_1_SENT',
  'FOLLOW_UP_2_DUE',
  'FOLLOW_UP_2_SENT',
  'REPLIED_POSITIVE',
  'REPLIED_NEUTRAL',
  'REPLIED_NEGATIVE',
  'BOUNCED',
  'UNSUBSCRIBED',
  'DO_NOT_CONTACT',
  'MEETING_BOOKED',
  'CLOSED_WON',
  'CLOSED_LOST',
] as const;

export type OutreachStatus = (typeof OUTREACH_STATUSES)[number];

/**
 * Terminal states: no outgoing transition is ever legal from these. A reply,
 * bounce, unsubscribe, do-not-contact, booked meeting, or a closed deal ends the
 * automated sequence; only human-driven outcome edits move between the non-blocking
 * terminals (handled explicitly in the transition table, not here).
 */
export const OUTREACH_TERMINAL: readonly OutreachStatus[] = [
  'UNSUBSCRIBED',
  'DO_NOT_CONTACT',
  'CLOSED_WON',
  'CLOSED_LOST',
];

/**
 * "Reply" terminals for the sequence: any of these means the prospect answered and
 * all pending follow-ups must be cancelled. They are not fully terminal — a reply
 * can still lead to MEETING_BOOKED / CLOSED_* — so they are handled in the map.
 */
export const OUTREACH_REPLY_STATUSES: readonly OutreachStatus[] = [
  'REPLIED_POSITIVE',
  'REPLIED_NEUTRAL',
  'REPLIED_NEGATIVE',
];

/**
 * Statuses that must block any future send. do-not-contact / unsubscribe are hard
 * suppression; bounce means the address is unusable; a closed deal is finished.
 */
export const OUTREACH_SEND_BLOCKED: readonly OutreachStatus[] = [
  'BOUNCED',
  'UNSUBSCRIBED',
  'DO_NOT_CONTACT',
  'CLOSED_WON',
  'CLOSED_LOST',
];

/**
 * Statuses under which NO follow-up may ever be created or remain pending: any
 * reply, a bounce, unsubscribe, do-not-contact, a booked meeting, or a closed deal.
 */
export const OUTREACH_NO_FOLLOWUP: readonly OutreachStatus[] = [
  ...OUTREACH_REPLY_STATUSES,
  'BOUNCED',
  'UNSUBSCRIBED',
  'DO_NOT_CONTACT',
  'MEETING_BOOKED',
  'CLOSED_WON',
  'CLOSED_LOST',
];

export function isOutreachStatus(value: string): value is OutreachStatus {
  return (OUTREACH_STATUSES as readonly string[]).includes(value);
}
