import { type FollowupStep } from './followups.js';
import { type OutreachStatus } from './status.js';

/**
 * The single source of truth for the outreach SEQUENCE: how the business/lesson numbering maps
 * onto the internal model, and which record status belongs to which step.
 *
 * ## Business (lesson) numbering vs internal numbering
 *
 * The lesson sequence contains FOUR TOTAL EMAILS, not four follow-ups:
 *
 * | lesson name     | day | internal sequenceStep | internal statuses                      |
 * |-----------------|-----|-----------------------|----------------------------------------|
 * | Outreach #1     |  0  | 0 (INITIAL)           | INITIAL_SENT                           |
 * | Follow-up #2    |  2  | 1                     | FOLLOW_UP_1_DUE / FOLLOW_UP_1_SENT     |
 * | Follow-up #3    |  4  | 2                     | FOLLOW_UP_2_DUE / FOLLOW_UP_2_SENT     |
 * | Follow-up #4    |  7  | 3                     | FOLLOW_UP_3_DUE / FOLLOW_UP_3_SENT     |
 *
 * The internal statuses were NOT renamed to the lesson numbering: `FOLLOW_UP_1_*` is the lesson's
 * Follow-up #2, `FOLLOW_UP_2_*` is Follow-up #3, and `FOLLOW_UP_3_*` is Follow-up #4. There is no
 * internal step 4 and no `FOLLOW_UP_4_*` status: after internal step 3 (lesson Follow-up #4) the
 * automated sequence is finished and nothing further is ever scheduled.
 *
 * Timing is expressed RELATIVE to the previous sent email (see {@link SequencePolicy}), so the
 * lesson's absolute days 0/2/4/7 become relative delays of 2, 2, and 3 days.
 */

/** The last internal follow-up step. Nothing is ever scheduled after this one. */
export const FINAL_FOLLOWUP_STEP: FollowupStep = 3;

export const FOLLOWUP_STEPS: readonly FollowupStep[] = [1, 2, 3];

/** Every sequence position an outbound sequence email can occupy (0 = INITIAL). */
export type SequenceStep = 0 | FollowupStep;

export function isFollowupStep(value: number): value is FollowupStep {
  return value === 1 || value === 2 || value === 3;
}

export function isSequenceStep(value: number): value is SequenceStep {
  return value === 0 || isFollowupStep(value);
}

/** The lesson-facing email number for an internal step (0 -> "Outreach #1", 1 -> "Follow-up #2"). */
export function lessonEmailNumber(step: SequenceStep): number {
  return step + 1;
}

/** Human-readable lesson label, used in operator output and prompts. */
export function lessonEmailLabel(step: SequenceStep): string {
  return step === 0 ? 'Outreach #1' : `Follow-up #${String(lessonEmailNumber(step))}`;
}

const DUE_STATUS: Record<FollowupStep, OutreachStatus> = {
  1: 'FOLLOW_UP_1_DUE',
  2: 'FOLLOW_UP_2_DUE',
  3: 'FOLLOW_UP_3_DUE',
};

const SENT_STATUS: Record<FollowupStep, OutreachStatus> = {
  1: 'FOLLOW_UP_1_SENT',
  2: 'FOLLOW_UP_2_SENT',
  3: 'FOLLOW_UP_3_SENT',
};

/** The record status meaning "follow-up <step> is pending". */
export function followupDueStatus(step: FollowupStep): OutreachStatus {
  return DUE_STATUS[step];
}

/** The record status meaning "follow-up <step> has been sent". */
export function followupSentStatus(step: FollowupStep): OutreachStatus {
  return SENT_STATUS[step];
}

/**
 * The follow-up step a record in this status is waiting to send, or null when the record is not
 * waiting on a follow-up (initial states, replies, bounces, terminals, and the finished sequence).
 * This is the ONLY way the confirmed-follow-up bridge derives the expected step from state — never
 * from subject text, a timestamp, or "the latest email".
 */
export function pendingFollowupStep(status: OutreachStatus): FollowupStep | null {
  switch (status) {
    case 'FOLLOW_UP_1_DUE': return 1;
    case 'FOLLOW_UP_2_DUE': return 2;
    case 'FOLLOW_UP_3_DUE': return 3;
    default: return null;
  }
}

/**
 * The next follow-up step after `step`, or null when `step` is the final one. Returning null is
 * what stops the sequence: after internal step 3 / lesson Follow-up #4 no further email is ever
 * scheduled.
 */
export function nextFollowupStep(step: FollowupStep): FollowupStep | null {
  return step >= FINAL_FOLLOWUP_STEP ? null : ((step + 1) as FollowupStep);
}

/**
 * The status a record must already be in for follow-up `step` to become due. Step 1 follows the
 * initial send; every later step follows the previous follow-up's SENT status.
 */
export function statusBeforeFollowupDue(step: FollowupStep): OutreachStatus {
  return step === 1 ? 'INITIAL_SENT' : followupSentStatus((step - 1) as FollowupStep);
}
