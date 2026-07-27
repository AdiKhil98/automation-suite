import { utcToLocal, zonedWallClockToUtc } from '../schedule/timezone.js';
import { OUTREACH_NO_FOLLOWUP, type OutreachStatus } from './status.js';

/**
 * Phase 17A follow-up scheduling — CALCULATION ONLY. This module computes explicit,
 * timezone-aware follow-up due dates and overdue amounts. It NEVER sends: there is no
 * code path here (or anywhere in Phase 17A) that dispatches a follow-up email.
 */

export type FollowupStep = 1 | 2;

export interface SequencePolicy {
  /** Whole-day offsets from the previous step's sent time to the next step's due date. */
  step1DelayDays: number;
  step2DelayDays: number;
  /** Local hour (0-23) in the recipient timezone at which a follow-up becomes due. */
  dueHourLocal: number;
}

export const DEFAULT_SEQUENCE_POLICY: SequencePolicy = {
  step1DelayDays: 3,
  step2DelayDays: 5,
  dueHourLocal: 9,
};

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
  const delayDays = args.step === 1 ? args.policy.step1DelayDays : args.policy.step2DelayDays;
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
