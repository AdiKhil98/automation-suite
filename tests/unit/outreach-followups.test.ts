import { describe, expect, it } from 'vitest';
import {
  computeFollowupDueUtc,
  DEFAULT_SEQUENCE_POLICY,
  followupAllowedForStatus,
  followupBlockedReason,
  isDue,
  overdueDays,
  type SequencePolicy,
} from '../../src/domain/outreach/followups.js';

const policy: SequencePolicy = { step1DelayDays: 3, step2DelayDays: 5, dueHourLocal: 9 };

describe('follow-up calculation', () => {
  it('computes a step-1 due date at the local due hour, N days later', () => {
    // Sent 2026-07-20 15:00 Berlin. +3 days, pinned to 09:00 local.
    const sentMs = Date.parse('2026-07-20T13:00:00Z'); // 15:00 Europe/Berlin (CEST, +2)
    const due = computeFollowupDueUtc({ previousSentAtMs: sentMs, step: 1, timezone: 'Europe/Berlin', policy });
    // 2026-07-23 09:00 CEST = 07:00 UTC
    expect(due.toISOString()).toBe('2026-07-23T07:00:00.000Z');
  });

  it('uses the step-2 delay for step 2', () => {
    const sentMs = Date.parse('2026-07-20T13:00:00Z');
    const due = computeFollowupDueUtc({ previousSentAtMs: sentMs, step: 2, timezone: 'Europe/Berlin', policy });
    // +5 days -> 2026-07-25 09:00 CEST = 07:00 UTC
    expect(due.toISOString()).toBe('2026-07-25T07:00:00.000Z');
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
  });

  it('ships sane defaults', () => {
    expect(DEFAULT_SEQUENCE_POLICY.step1DelayDays).toBeGreaterThan(0);
  });
});
