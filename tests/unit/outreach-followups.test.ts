import { describe, expect, it } from 'vitest';
import {
  computeFollowupDueUtc,
  DEFAULT_SEQUENCE_POLICY,
  followupAllowedForStatus,
  followupBlockedReason,
  isDue,
  overdueDays,
  stepDelayDays,
  type SequencePolicy,
} from '../../src/domain/outreach/followups.js';
import {
  FINAL_FOLLOWUP_STEP,
  followupDueStatus,
  followupSentStatus,
  isFollowupStep,
  lessonEmailLabel,
  nextFollowupStep,
  pendingFollowupStep,
  statusBeforeFollowupDue,
} from '../../src/domain/outreach/sequence.js';

const policy: SequencePolicy = { step1DelayDays: 2, step2DelayDays: 2, step3DelayDays: 3, dueHourLocal: 9 };
const TZ = 'Europe/Berlin';
/** 2026-07-20 15:00 Europe/Berlin (CEST, UTC+2). */
const SENT = Date.parse('2026-07-20T13:00:00Z');

describe('follow-up scheduling — lesson timing', () => {
  // The lesson expresses the sequence in ABSOLUTE days (Outreach #1 day 0, Follow-up #2 day 2,
  // #3 day 4, #4 day 7). Delays here are RELATIVE to the previous sent email, so they are 2, 2, 3.
  it('schedules internal step 1 (= lesson Follow-up #2) +2 local calendar days', () => {
    const due = computeFollowupDueUtc({ previousSentAtMs: SENT, step: 1, timezone: TZ, policy });
    // 2026-07-22 09:00 CEST = 07:00 UTC
    expect(due.toISOString()).toBe('2026-07-22T07:00:00.000Z');
  });

  it('schedules internal step 2 (= lesson Follow-up #3) +2 local calendar days', () => {
    const due = computeFollowupDueUtc({ previousSentAtMs: SENT, step: 2, timezone: TZ, policy });
    expect(due.toISOString()).toBe('2026-07-22T07:00:00.000Z');
  });

  it('schedules internal step 3 (= lesson Follow-up #4) +3 local calendar days', () => {
    const due = computeFollowupDueUtc({ previousSentAtMs: SENT, step: 3, timezone: TZ, policy });
    // 2026-07-23 09:00 CEST = 07:00 UTC
    expect(due.toISOString()).toBe('2026-07-23T07:00:00.000Z');
  });

  it('composes to the lesson absolute days 0 / 2 / 4 / 7', () => {
    const day = 86_400_000;
    const s1 = computeFollowupDueUtc({ previousSentAtMs: SENT, step: 1, timezone: TZ, policy });
    const s2 = computeFollowupDueUtc({ previousSentAtMs: s1.getTime(), step: 2, timezone: TZ, policy });
    const s3 = computeFollowupDueUtc({ previousSentAtMs: s2.getTime(), step: 3, timezone: TZ, policy });
    // Measured from the send DATE (the due hour is pinned, so compare local calendar days).
    expect(Math.round((s1.getTime() - Date.parse('2026-07-20T07:00:00Z')) / day)).toBe(2);
    expect(Math.round((s2.getTime() - Date.parse('2026-07-20T07:00:00Z')) / day)).toBe(4);
    expect(Math.round((s3.getTime() - Date.parse('2026-07-20T07:00:00Z')) / day)).toBe(7);
  });

  it('stays DST-correct across the autumn transition', () => {
    // Sent Fri 2026-10-23 15:00 CEST (+2). Berlin leaves DST on Sun 2026-10-25, so the step-3 due
    // date (+3 local days = Mon 2026-10-26) falls in CET (+1): 09:00 local is 08:00 UTC, not 07:00.
    const sent = Date.parse('2026-10-23T13:00:00Z');
    const due = computeFollowupDueUtc({ previousSentAtMs: sent, step: 3, timezone: TZ, policy });
    expect(due.toISOString()).toBe('2026-10-26T08:00:00.000Z');
  });

  it('resolves each step to its own configured delay', () => {
    expect(stepDelayDays(1, policy)).toBe(2);
    expect(stepDelayDays(2, policy)).toBe(2);
    expect(stepDelayDays(3, policy)).toBe(3);
  });

  it('ships the lesson timing as the default policy', () => {
    expect(DEFAULT_SEQUENCE_POLICY.step1DelayDays).toBe(2);
    expect(DEFAULT_SEQUENCE_POLICY.step2DelayDays).toBe(2);
    expect(DEFAULT_SEQUENCE_POLICY.step3DelayDays).toBe(3);
  });

  it('computes overdue days and due-ness', () => {
    const due = Date.parse('2026-07-23T07:00:00Z');
    expect(isDue(due, Date.parse('2026-07-23T08:00:00Z'))).toBe(true);
    expect(isDue(due, Date.parse('2026-07-22T08:00:00Z'))).toBe(false);
    expect(overdueDays(due, Date.parse('2026-07-25T07:00:00Z'))).toBe(2);
    expect(overdueDays(due, Date.parse('2026-07-23T06:00:00Z'))).toBe(0);
  });

  it('blocks follow-ups for terminal / reply statuses', () => {
    expect(followupAllowedForStatus('INITIAL_SENT')).toBe(true);
    expect(followupAllowedForStatus('REPLIED_POSITIVE')).toBe(false);
    expect(followupBlockedReason('REPLIED_NEUTRAL')).toBe('REPLY_DETECTED');
    expect(followupBlockedReason('BOUNCED')).toBe('BOUNCED');
    expect(followupBlockedReason('UNSUBSCRIBED')).toBe('UNSUBSCRIBED');
    expect(followupBlockedReason('MEETING_BOOKED')).toBe('MEETING_BOOKED');
    expect(followupBlockedReason('CLOSED_WON')).toBe('CLOSED');
    expect(followupBlockedReason('INITIAL_SENT')).toBeNull();
    // The finished sequence still permits nothing further to be scheduled.
    expect(followupBlockedReason('FOLLOW_UP_3_SENT')).toBeNull();
  });
});

describe('sequence mapping (lesson numbering vs internal numbering)', () => {
  it('maps internal steps onto the lesson email numbers', () => {
    expect(lessonEmailLabel(0)).toBe('Outreach #1');
    expect(lessonEmailLabel(1)).toBe('Follow-up #2');
    expect(lessonEmailLabel(2)).toBe('Follow-up #3');
    expect(lessonEmailLabel(3)).toBe('Follow-up #4');
  });

  it('recognises exactly steps 1-3 as follow-ups — never a step 4', () => {
    expect(isFollowupStep(1)).toBe(true);
    expect(isFollowupStep(3)).toBe(true);
    expect(isFollowupStep(0)).toBe(false);
    expect(isFollowupStep(4)).toBe(false);
    expect(FINAL_FOLLOWUP_STEP).toBe(3);
  });

  it('pairs each step with its DUE and SENT statuses', () => {
    expect(followupDueStatus(1)).toBe('FOLLOW_UP_1_DUE');
    expect(followupSentStatus(1)).toBe('FOLLOW_UP_1_SENT');
    expect(followupDueStatus(3)).toBe('FOLLOW_UP_3_DUE');
    expect(followupSentStatus(3)).toBe('FOLLOW_UP_3_SENT');
  });

  it('derives the pending step from the record status alone', () => {
    expect(pendingFollowupStep('FOLLOW_UP_1_DUE')).toBe(1);
    expect(pendingFollowupStep('FOLLOW_UP_2_DUE')).toBe(2);
    expect(pendingFollowupStep('FOLLOW_UP_3_DUE')).toBe(3);
    expect(pendingFollowupStep('INITIAL_SENT')).toBeNull();
    expect(pendingFollowupStep('FOLLOW_UP_3_SENT')).toBeNull();
    expect(pendingFollowupStep('REPLIED_POSITIVE')).toBeNull();
  });

  it('ends the sequence after the final step', () => {
    expect(nextFollowupStep(1)).toBe(2);
    expect(nextFollowupStep(2)).toBe(3);
    expect(nextFollowupStep(3)).toBeNull();
  });

  it('knows which status must precede each step becoming due', () => {
    expect(statusBeforeFollowupDue(1)).toBe('INITIAL_SENT');
    expect(statusBeforeFollowupDue(2)).toBe('FOLLOW_UP_1_SENT');
    expect(statusBeforeFollowupDue(3)).toBe('FOLLOW_UP_2_SENT');
  });
});
