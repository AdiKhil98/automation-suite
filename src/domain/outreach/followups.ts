import { utcToLocal, zonedWallClockToUtc } from '../schedule/timezone.js';
import { OUTREACH_NO_FOLLOWUP, type OutreachStatus } from './status.js';

/**
 * Follow-up scheduling — CALCULATION ONLY. This module computes explicit, timezone-aware
 * follow-up due dates and overdue amounts. It NEVER sends: no code path here dispatches an
 * email. Dispatch happens only through the production SendService.
 *
 * SEQUENCE NAMING: internal step 1 is the lesson's Follow-up #2, step 2 is Follow-up #3, and
 * step 3 is Follow-up #4 (the final email). See `sequence.ts` for the complete mapping.
 */

export type FollowupStep = 1 | 2 | 3;

export interface SequencePolicy {
  /**
   * Whole-day offsets from the PREVIOUS sent email to this step's due date. The lesson expresses
   * the sequence in absolute days (Outreach #1 = day 0, Follow-up #2 = day 2, #3 = day 4,
   * #4 = day 7); because these delays are relative to the previous send, that becomes 2, 2, 3.
   */
  step1DelayDays: number;
  step2DelayDays: number;
  step3DelayDays: number;
  /** Local hour (0-23) in the recipient timezone at which a follow-up becomes due. */
  dueHourLocal: number;
}

/** Lesson timing: day 0 -> +2 -> +2 -> +3 (absolute days 0, 2, 4, 7). */
export const DEFAULT_SEQUENCE_POLICY: SequencePolicy = {
  step1DelayDays: 2,
  step2DelayDays: 2,
  step3DelayDays: 3,
  dueHourLocal: 9,
};

/** The whole-day delay this step waits after the previous sent email. */
export function stepDelayDays(step: FollowupStep, policy: SequencePolicy): number {
  switch (step) {
    case 1: return policy.step1DelayDays;
    case 2: return policy.step2DelayDays;
    case 3: return policy.step3DelayDays;
  }
}

/**
 * Compute the UTC instant a follow-up becomes due: `previousSentAt` advanced by the
 * step delay (in whole calendar days, in the recipient's timezone) and pinned to the
 * policy's local due-hour. DST-correct via the shared timezone helpers.
 */
export function computeFollowupDueUtc(args: {
  previousSentAtMs: number;
  step: FollowupStep;
  timezone: string;
  policy: SequencePolicy;
}): Date {
  const delayDays = stepDelayDays(args.step, args.policy);
  const local = utcToLocal(args.timezone, args.previousSentAtMs);
  // Advance the local calendar date by delayDays, then pin to the due hour.
  const base = Date.UTC(local.year, local.month - 1, local.day + delayDays);
  const advanced = new Date(base);
  const dueUtcMs = zonedWallClockToUtc(
    args.timezone,
    advanced.getUTCFullYear(),
    advanced.getUTCMonth() + 1,
    advanced.getUTCDate(),
    args.policy.dueHourLocal,
    0,
  );
  return new Date(dueUtcMs);
}

/** Whole days `dueAt` is overdue relative to `now` (0 if not yet due). */
export function overdueDays(dueAtMs: number, nowMs: number): number {
  if (nowMs <= dueAtMs) return 0;
  return Math.floor((nowMs - dueAtMs) / 86_400_000);
}

/** True when a follow-up is currently due (its due instant has passed). */
export function isDue(dueAtMs: number, nowMs: number): boolean {
  return nowMs >= dueAtMs;
}

/**
 * Whether a follow-up may exist at all for a record in the given status. Follow-ups
 * are forbidden after any reply, bounce, unsubscribe, do-not-contact, a booked
 * meeting, or a closed deal.
 */
export function followupAllowedForStatus(status: OutreachStatus): boolean {
  return !OUTREACH_NO_FOLLOWUP.includes(status);
}

export type FollowupBlockedReason =
  | 'REPLY_DETECTED'
  | 'BOUNCED'
  | 'UNSUBSCRIBED'
  | 'DO_NOT_CONTACT'
  | 'MEETING_BOOKED'
  | 'CLOSED'
  | null;

/** The reason a follow-up is blocked for a status, or null if it is permitted. */
export function followupBlockedReason(status: OutreachStatus): FollowupBlockedReason {
  switch (status) {
    case 'REPLIED_POSITIVE':
    case 'REPLIED_NEUTRAL':
    case 'REPLIED_NEGATIVE':
      return 'REPLY_DETECTED';
    case 'BOUNCED':
      return 'BOUNCED';
    case 'UNSUBSCRIBED':
      return 'UNSUBSCRIBED';
    case 'DO_NOT_CONTACT':
      return 'DO_NOT_CONTACT';
    case 'MEETING_BOOKED':
      return 'MEETING_BOOKED';
    case 'CLOSED_WON':
    case 'CLOSED_LOST':
      return 'CLOSED';
    default:
      return null;
  }
}
