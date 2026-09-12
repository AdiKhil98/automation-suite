import { type FollowupBlockedReason, followupBlockedReason } from './followups.js';
import { pendingFollowupStep } from './sequence.js';
import { type OutreachStatus } from './status.js';

/**
 * The FINAL, authoritative suppression re-check performed immediately before a prepared follow-up
 * is handed to the production `SendService`.
 *
 * A follow-up is written, reviewed, approved, and scheduled DAYS before it is due. In that window
 * the prospect may reply, unsubscribe, bounce permanently, book a meeting, or be marked
 * do-not-contact. The decision made when the copy was prepared is therefore stale by definition and
 * must never be trusted at send time. This module re-reads the CURRENT outreach state and fails
 * closed: anything other than "this record is still waiting for exactly this follow-up step" blocks
 * the send.
 *
 * It deliberately reuses {@link followupBlockedReason} — the same predicate reply sync and delivery
 * reconciliation use to cancel pending follow-ups — so suppression can never drift between workers.
 * This gate is the last line of defence, not a replacement for those cancellations.
 *
 * Nothing here sends, and nothing here mutates: it is a pure decision.
 */

export type FollowupSendDecision =
  /** The record still awaits exactly this step; the existing send pipeline may proceed. */
  | { allowed: true; step: 1 | 2 | 3 }
  /** Fail closed. `reason` is the machine-readable cause; `detail` is operator-facing. */
  | { allowed: false; reason: FollowupSendBlockReason; detail: string };

export type FollowupSendBlockReason =
  | FollowupBlockedReason & string
  /** The record is not waiting on any follow-up (e.g. still INITIAL_SENT, or the sequence is done). */
  | 'NOT_AWAITING_FOLLOWUP'
  /** The prepared copy's step and the record's current step disagree. */
  | 'STEP_MISMATCH'
  /** No outreach record could be found for this send. */
  | 'NO_OUTREACH_RECORD';

export interface FollowupSendSnapshot {
  /** The CURRENT status of the outreach record, re-read now — never a cached/prepared value. */
  status: OutreachStatus | null;
  /** Contact-level do-not-contact, re-read now. */
  doNotContact: boolean;
  /** The sequence step the prepared, scheduled email was written for. */
  preparedStep: 1 | 2 | 3;
}

/**
 * Decide whether a prepared follow-up may still be sent. Fail-closed at every branch: a missing
 * record, a suppressed record, a record that is not awaiting a follow-up, and a step disagreement
 * all block.
 */
export function checkFollowupSendAllowed(snap: FollowupSendSnapshot): FollowupSendDecision {
  if (snap.status === null) {
    return { allowed: false, reason: 'NO_OUTREACH_RECORD', detail: 'no outreach record for this send' };
  }
  if (snap.doNotContact) {
    return { allowed: false, reason: 'DO_NOT_CONTACT', detail: 'contact is marked do-not-contact' };
  }
  const blocked = followupBlockedReason(snap.status);
  if (blocked !== null) {
    return { allowed: false, reason: blocked, detail: `outreach record is ${snap.status}` };
  }
  const step = pendingFollowupStep(snap.status);
  if (step === null) {
    return {
      allowed: false,
      reason: 'NOT_AWAITING_FOLLOWUP',
      detail: `outreach record is ${snap.status} and is not awaiting a follow-up`,
    };
  }
  if (step !== snap.preparedStep) {
    return {
      allowed: false,
      reason: 'STEP_MISMATCH',
      detail: `prepared follow-up is step ${String(snap.preparedStep)} but the record awaits step ${String(step)}`,
    };
  }
  return { allowed: true, step };
}
