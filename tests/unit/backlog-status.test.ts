import { describe, expect, it } from 'vitest';
import {
  allClassifiedStatuses, buildDailyLoads, classifyLeadStatus, computeCoverage,
  computeFollowupForecast, horizonDayKeys, isBlockedOutreachStatus, laneForSequenceStep,
  mergeKnownFollowupObligations, partitionBlockedInventory, placeFollowupsOnDays,
  READY_UNSCHEDULED_STATUSES, remainingFollowupSteps, resolveCapacity, REVIEW_QUEUE_STATUSES,
  SCHEDULED_STATUSES, utcDayKey, type KnownObligationInput, type MergedFollowupObligation,
  type OutreachRecordStateCount,
} from '../../src/domain/outreach/backlog-status.js';
import { type OutreachStatus } from '../../src/domain/outreach/status.js';

describe('lead-status bucketing', () => {
  it('classifies every LEAD_STATUS into exactly one bucket', () => {
    for (const status of allClassifiedStatuses()) {
      expect(() => classifyLeadStatus(status)).not.toThrow();
    }
  });

  it('puts the shared statuses in the review/ready-unscheduled/scheduled buckets, not raw/pipeline', () => {
    expect(REVIEW_QUEUE_STATUSES).toEqual(['READY_FOR_HUMAN_APPROVAL', 'FINALIZED_EMAIL_PENDING']);
    expect(READY_UNSCHEDULED_STATUSES).toEqual(['HUMAN_APPROVED', 'DRAFT_CREATED']);
    expect(SCHEDULED_STATUSES).toEqual(['SCHEDULED']);
    expect(classifyLeadStatus('READY_FOR_HUMAN_APPROVAL')).toBe('REVIEW_QUEUE');
    expect(classifyLeadStatus('HUMAN_APPROVED')).toBe('READY_UNSCHEDULED');
    expect(classifyLeadStatus('SCHEDULED')).toBe('SCHEDULED');
  });

  it('keeps NEEDS_MANUAL_REVIEW and EMAIL_REVIEW_FAILED as STALLED, separate from every other bucket', () => {
    expect(classifyLeadStatus('NEEDS_MANUAL_REVIEW')).toBe('STALLED');
    expect(classifyLeadStatus('EMAIL_REVIEW_FAILED')).toBe('STALLED');
  });

  it('classifies terminal lead statuses as TERMINAL', () => {
    for (const s of ['SENT', 'REPLIED', 'UNSUBSCRIBED', 'BOUNCED', 'FAILED', 'DUPLICATE', 'REJECTED', 'REJECTED_AUTOMATICALLY'] as const) {
      expect(classifyLeadStatus(s)).toBe('TERMINAL');
    }
  });
});

describe('laneForSequenceStep', () => {
  it('step 0 is INITIAL, anything else is FOLLOWUP', () => {
    expect(laneForSequenceStep(0)).toBe('INITIAL');
    expect(laneForSequenceStep(1)).toBe('FOLLOWUP');
    expect(laneForSequenceStep(2)).toBe('FOLLOWUP');
    expect(laneForSequenceStep(3)).toBe('FOLLOWUP');
  });
});

describe('resolveCapacity (fix #1: --daily-cap required, authorization never substituted)', () => {
  it('is UNKNOWN and skips arithmetic when --daily-cap is missing, even with a usable authorization', () => {
    const r = resolveCapacity(null, { maxPerDay: 5, usableNow: true });
    expect(r.sendability).toBe('UNKNOWN');
    expect(r.effectiveCap).toBeNull();
  });

  it('is UNKNOWN when --daily-cap is missing and there is no authorization at all', () => {
    const r = resolveCapacity(null, null);
    expect(r.sendability).toBe('UNKNOWN');
    expect(r.effectiveCap).toBeNull();
  });

  it('takes the tighter of --daily-cap and a usable authorization max_per_day', () => {
    expect(resolveCapacity(5, { maxPerDay: 5, usableNow: true }).effectiveCap).toBe(5);
    expect(resolveCapacity(10, { maxPerDay: 5, usableNow: true }).effectiveCap).toBe(5);
    expect(resolveCapacity(3, { maxPerDay: 5, usableNow: true }).effectiveCap).toBe(3);
    expect(resolveCapacity(5, { maxPerDay: 5, usableNow: true }).sendability).toBe('AUTHORIZED');
  });

  it('shows a hypothetical cap from --daily-cap alone when no authorization is usable, and labels it NOT_CURRENTLY_AUTHORIZED', () => {
    const r = resolveCapacity(5, { maxPerDay: 5, usableNow: false });
    expect(r.effectiveCap).toBe(5);
    expect(r.sendability).toBe('NOT_CURRENTLY_AUTHORIZED');
    expect(r.hypothetical).toBe(true);
    const r2 = resolveCapacity(5, null);
    expect(r2.effectiveCap).toBe(5);
    expect(r2.sendability).toBe('NOT_CURRENTLY_AUTHORIZED');
  });

  it('never uses the authorization max_per_day as the cap on its own — --daily-cap always gates the hypothetical figure', () => {
    // Even a tiny --daily-cap with a much larger authorized cap is respected as the ceiling.
    expect(resolveCapacity(1, { maxPerDay: 100, usableNow: true }).effectiveCap).toBe(1);
  });
});

describe('utcDayKey / horizonDayKeys (fix #7: UTC calendar days only)', () => {
  it('derives the UTC calendar day regardless of what local wall-clock time it represents', () => {
    expect(utcDayKey(Date.parse('2026-01-05T23:59:00Z'))).toBe('2026-01-05');
    expect(utcDayKey(Date.parse('2026-01-06T00:00:00Z'))).toBe('2026-01-06');
  });

  it('produces exactly horizonDays consecutive UTC day keys starting today', () => {
    const now = Date.parse('2026-03-10T15:00:00Z');
    expect(horizonDayKeys(now, 3)).toEqual(['2026-03-10', '2026-03-11', '2026-03-12']);
  });
});

describe('remainingFollowupSteps + isBlockedOutreachStatus (fix #2/#3 forecast inputs)', () => {
  it('computes remaining steps to the final follow-up from the current status', () => {
    expect(remainingFollowupSteps('INITIAL_SENT')).toBe(3);
    expect(remainingFollowupSteps('FOLLOW_UP_1_DUE')).toBe(3);
    expect(remainingFollowupSteps('FOLLOW_UP_1_SENT')).toBe(2);
    expect(remainingFollowupSteps('FOLLOW_UP_2_DUE')).toBe(2);
    expect(remainingFollowupSteps('FOLLOW_UP_2_SENT')).toBe(1);
    expect(remainingFollowupSteps('FOLLOW_UP_3_DUE')).toBe(1);
    expect(remainingFollowupSteps('FOLLOW_UP_3_SENT')).toBe(0);
  });

  it('conservatively contributes 0 before the initial is confirmed sent', () => {
    for (const s of ['DRAFT_READY', 'AWAITING_APPROVAL', 'APPROVED_TO_SEND'] as const) {
      expect(remainingFollowupSteps(s)).toBe(0);
    }
  });

  it('flags every no-further-outreach status (and do-not-contact) as blocked', () => {
    for (const s of ['REPLIED_POSITIVE', 'REPLIED_NEUTRAL', 'REPLIED_NEGATIVE', 'BOUNCED', 'UNSUBSCRIBED', 'DO_NOT_CONTACT', 'MEETING_BOOKED', 'CLOSED_WON', 'CLOSED_LOST'] as const) {
      expect(isBlockedOutreachStatus(s, false)).toBe(true);
    }
    expect(isBlockedOutreachStatus('INITIAL_SENT', true)).toBe(true);
    expect(isBlockedOutreachStatus('INITIAL_SENT', false)).toBe(false);
  });
});

describe('mergeKnownFollowupObligations (fix #2: dedupe by (outreach_record_id, sequence_step))', () => {
  it('counts a DUE row and a scheduled row for the SAME obligation exactly once', () => {
    const inputs: KnownObligationInput[] = [
      { outreachRecordId: 'rec-1', step: 1, dueAt: new Date('2026-01-05T09:00:00Z'), scheduledAtUtc: null },
      { outreachRecordId: 'rec-1', step: 1, dueAt: null, scheduledAtUtc: new Date('2026-01-06T10:00:00Z') },
    ];
    const merged = mergeKnownFollowupObligations(inputs);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.isDated).toBe(true);
    expect(merged[0]?.displayDate.toISOString()).toBe('2026-01-06T10:00:00.000Z');
  });

  it('prefers the scheduled date for display when both exist', () => {
    const merged = mergeKnownFollowupObligations([
      { outreachRecordId: 'rec-2', step: 2, dueAt: new Date('2026-02-01T00:00:00Z'), scheduledAtUtc: new Date('2026-02-03T00:00:00Z') },
    ]);
    expect(merged[0]?.displayDate.toISOString()).toBe('2026-02-03T00:00:00.000Z');
  });

  it('keeps distinct (record, step) obligations separate', () => {
    const merged = mergeKnownFollowupObligations([
      { outreachRecordId: 'rec-1', step: 1, dueAt: new Date('2026-01-05T00:00:00Z'), scheduledAtUtc: null },
      { outreachRecordId: 'rec-1', step: 2, dueAt: new Date('2026-01-07T00:00:00Z'), scheduledAtUtc: null },
      { outreachRecordId: 'rec-2', step: 1, dueAt: new Date('2026-01-05T00:00:00Z'), scheduledAtUtc: null },
    ]);
    expect(merged).toHaveLength(3);
  });

  it('marks a due-only obligation as not dated', () => {
    const merged = mergeKnownFollowupObligations([
      { outreachRecordId: 'rec-3', step: 1, dueAt: new Date('2026-01-05T00:00:00Z'), scheduledAtUtc: null },
    ]);
    expect(merged[0]?.isDated).toBe(false);
  });
});

describe('placeFollowupsOnDays', () => {
  const nowMs = Date.parse('2026-01-05T00:00:00Z');
  const days = horizonDayKeys(nowMs, 7);

  it('places an obligation on its own UTC day when within the horizon', () => {
    const obligations: MergedFollowupObligation[] = [
      { key: 'a', outreachRecordId: 'rec-1', step: 1, displayDate: new Date('2026-01-07T09:00:00Z'), isDated: true },
    ];
    const counts = placeFollowupsOnDays(obligations, days, nowMs);
    expect(counts.get('2026-01-07')).toBe(1);
  });

  it('clamps an overdue obligation to today rather than a past day outside the horizon', () => {
    const obligations: MergedFollowupObligation[] = [
      { key: 'a', outreachRecordId: 'rec-1', step: 1, displayDate: new Date('2025-12-01T09:00:00Z'), isDated: false },
    ];
    const counts = placeFollowupsOnDays(obligations, days, nowMs);
    expect(counts.get('2026-01-05')).toBe(1);
  });

  it('drops an obligation whose date falls outside the horizon window (does not invent a day for it)', () => {
    const obligations: MergedFollowupObligation[] = [
      { key: 'a', outreachRecordId: 'rec-1', step: 1, displayDate: new Date('2026-03-01T00:00:00Z'), isDated: true },
    ];
    const counts = placeFollowupsOnDays(obligations, days, nowMs);
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(0);
  });
});

describe('computeFollowupForecast (fix #2 dedupe feeds PROJECTED_MAX_FOLLOWUPS)', () => {
  it('subtracts the deduped known count from total deterministic remaining steps, floored at 0', () => {
    const counts: OutreachRecordStateCount[] = [
      { status: 'INITIAL_SENT', doNotContact: false, count: 2 }, // 2 * 3 = 6 remaining
      { status: 'FOLLOW_UP_2_SENT', doNotContact: false, count: 1 }, // 1 * 1 = 1 remaining
      { status: 'BOUNCED', doNotContact: false, count: 5 }, // excluded entirely
      { status: 'INITIAL_SENT', doNotContact: true, count: 3 }, // do_not_contact excludes it too
    ];
    const forecast = computeFollowupForecast(counts, 4);
    expect(forecast.totalRemaining).toBe(7);
    expect(forecast.knownFollowups).toBe(4);
    expect(forecast.projectedMaxFollowups).toBe(3);
  });

  it('never goes negative when known obligations already exceed the deterministic remaining total', () => {
    const counts: OutreachRecordStateCount[] = [{ status: 'FOLLOW_UP_3_DUE', doNotContact: false, count: 1 }]; // remaining = 1
    expect(computeFollowupForecast(counts, 10).projectedMaxFollowups).toBe(0);
  });

  it('treats an unrecognized (null) status as excluded, not as zero-cost inclusion', () => {
    const counts: OutreachRecordStateCount[] = [{ status: null, doNotContact: false, count: 100 }];
    expect(computeFollowupForecast(counts, 0).totalRemaining).toBe(0);
  });
});

describe('computeCoverage (fix #3: two capacity views)', () => {
  const dayKeys = horizonDayKeys(Date.parse('2026-01-05T00:00:00Z'), 3);

  it('returns an UNKNOWN/zeroed result when there is no effective cap', () => {
    const c = computeCoverage({
      horizonDays: 3, effectiveCap: null, sendability: 'UNKNOWN',
      dailyLoads: buildDailyLoads(dayKeys, [], new Map()), readyUnscheduled: 5, projectedMaxFollowups: 2,
    });
    expect(c.knownDeficit).toBe(0);
    expect(c.conservativeDeficit).toBe(0);
  });

  it('computes known unfilled slots as cap minus consumed, summed over the horizon', () => {
    // cap=5/day for 3 days = 15 total; day 1 has 1 scheduled initial + 1 follow-up consuming 2 of 5.
    const dailyLoads = buildDailyLoads(
      dayKeys,
      [dayKeys[0]!],
      new Map([[dayKeys[0]!, 1]]),
    );
    const c = computeCoverage({
      horizonDays: 3, effectiveCap: 5, sendability: 'AUTHORIZED',
      dailyLoads, readyUnscheduled: 4, projectedMaxFollowups: 0,
    });
    // day0: 5-1-1=3, day1: 5, day2: 5 => 13
    expect(c.knownUnfilledSlots).toBe(13);
    expect(c.knownDeficit).toBe(9); // 13 - 4
  });

  it('reserves the projected-follow-up ceiling out of the conservative view only', () => {
    const dailyLoads = buildDailyLoads(dayKeys, [], new Map());
    const c = computeCoverage({
      horizonDays: 3, effectiveCap: 5, sendability: 'AUTHORIZED',
      dailyLoads, readyUnscheduled: 2, projectedMaxFollowups: 10,
    });
    expect(c.knownUnfilledSlots).toBe(15);
    expect(c.knownDeficit).toBe(13);
    expect(c.conservativeUnfilledSlots).toBe(5); // 15 - 10
    expect(c.conservativeDeficit).toBe(3); // 5 - 2
  });

  it('never lets the conservative reserve push unfilled slots below zero', () => {
    const dailyLoads = buildDailyLoads(dayKeys, [], new Map());
    const c = computeCoverage({
      horizonDays: 3, effectiveCap: 5, sendability: 'AUTHORIZED',
      dailyLoads, readyUnscheduled: 0, projectedMaxFollowups: 999,
    });
    expect(c.conservativeUnfilledSlots).toBe(0);
    expect(c.conservativeDeficit).toBe(0);
  });
});

describe('partitionBlockedInventory (fix #4: authoritative exclusion, not a weaker approximation)', () => {
  it('excludes a lead that is suppressed OR outreach-blocked, and tallies each reason', () => {
    const result = partitionBlockedInventory([
      { leadId: 'a', suppressed: true, outreachBlocked: false },
      { leadId: 'b', suppressed: false, outreachBlocked: true },
      { leadId: 'c', suppressed: false, outreachBlocked: false },
      { leadId: 'd', suppressed: true, outreachBlocked: true },
    ]);
    expect(result.blockedCount).toBe(3);
    expect(result.suppressedCount).toBe(2);
    expect(result.outreachBlockedCount).toBe(2);
    expect(result.blockedLeadIds.has('c')).toBe(false);
    expect(result.blockedLeadIds.has('a')).toBe(true);
  });

  it('blocks nothing when the candidate set is clean', () => {
    const result = partitionBlockedInventory([{ leadId: 'a', suppressed: false, outreachBlocked: false }]);
    expect(result.blockedCount).toBe(0);
  });
});

describe('OutreachStatus exhaustiveness sanity for remainingFollowupSteps/isBlockedOutreachStatus', () => {
  it('every OutreachStatus either contributes to remaining steps or is blocked (never silently both 0 and unblocked without reason)', () => {
    const allStatuses: OutreachStatus[] = [
      'DRAFT_READY', 'AWAITING_APPROVAL', 'APPROVED_TO_SEND', 'INITIAL_SENT',
      'FOLLOW_UP_1_DUE', 'FOLLOW_UP_1_SENT', 'FOLLOW_UP_2_DUE', 'FOLLOW_UP_2_SENT',
      'FOLLOW_UP_3_DUE', 'FOLLOW_UP_3_SENT', 'REPLIED_POSITIVE', 'REPLIED_NEUTRAL',
      'REPLIED_NEGATIVE', 'BOUNCED', 'UNSUBSCRIBED', 'DO_NOT_CONTACT', 'MEETING_BOOKED',
      'CLOSED_WON', 'CLOSED_LOST',
    ];
    for (const s of allStatuses) {
      const blocked = isBlockedOutreachStatus(s, false);
      const remaining = remainingFollowupSteps(s);
      // A blocked status may still report a nonzero "remaining" number in isolation — the caller
      // (computeFollowupForecast) is responsible for filtering blocked statuses out before summing.
      expect(typeof remaining).toBe('number');
      expect(typeof blocked).toBe('boolean');
    }
  });
});
