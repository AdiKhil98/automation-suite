import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { isValidTimeZone, utcToLocal, zonedWallClockToUtc } from '../../src/domain/schedule/timezone.js';
import { computeNextSlot, isSlotAllowed, type SchedulingRules } from '../../src/domain/schedule/scheduler.js';
import { checkScheduleEligibility, type ScheduleEligibilitySnapshot } from '../../src/domain/schedule/eligibility.js';
import { scheduleIntegrityFingerprint } from '../../src/domain/schedule/fingerprint.js';
import {
  ScheduleService, type ScheduleConfig, type ScheduleInput, type ScheduleRecord, type ScheduleStore, type ScheduleTxRepos, type ScheduleUnitOfWork,
} from '../../src/domain/schedule/schedule-service.js';

const TZ = 'America/New_York'; // fictional recipient locale (IANA, not sensitive)
const rules: SchedulingRules = { windowStartHour: 9, windowEndHour: 17, allowedWeekdays: [1, 2, 3, 4, 5], minSpacingMinutes: 30, dailyCap: 20, earliestOffsetMinutes: 60, horizonDays: 14 };
const MON = Date.parse('2026-07-20T00:00:00Z'); // a Monday
const SAT = Date.parse('2026-07-18T00:00:00Z'); // a Saturday

describe('timezone helpers', () => {
  it('validates IANA zones', () => {
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
  it('converts local wall-clock to UTC with DST (summer EDT = -4)', () => {
    expect(zonedWallClockToUtc(TZ, 2026, 7, 20, 9, 0)).toBe(Date.parse('2026-07-20T13:00:00Z'));
    // winter EST = -5
    expect(zonedWallClockToUtc(TZ, 2026, 1, 20, 9, 0)).toBe(Date.parse('2026-01-20T14:00:00Z'));
  });
  it('reports ISO weekday from local date', () => {
    expect(utcToLocal(TZ, Date.parse('2026-07-20T13:00:00Z')).weekdayIso).toBe(1); // Monday
  });
});

describe('computeNextSlot (deterministic)', () => {
  it('picks the first in-window slot on the next allowed weekday ≥ earliest', () => {
    const r = computeNextSlot({ nowMs: MON, tz: TZ, rules, existingUtcMs: [] });
    expect(r.ok).toBe(true);
    expect(new Date(r.scheduledAtUtc!).toISOString()).toBe('2026-07-20T13:00:00.000Z'); // Mon 09:00 EDT
  });
  it('skips the weekend to Monday', () => {
    const r = computeNextSlot({ nowMs: SAT, tz: TZ, rules, existingUtcMs: [] });
    expect(new Date(r.scheduledAtUtc!).toISOString()).toBe('2026-07-20T13:00:00.000Z');
  });
  it('honors spacing against existing sends', () => {
    const first = '2026-07-20T13:00:00.000Z';
    const r = computeNextSlot({ nowMs: MON, tz: TZ, rules, existingUtcMs: [Date.parse(first)] });
    expect(new Date(r.scheduledAtUtc!).toISOString()).toBe('2026-07-20T13:30:00.000Z'); // +30m grid
  });
  it('rolls to the next day when the daily cap is reached', () => {
    const cap1 = { ...rules, dailyCap: 1 };
    const r = computeNextSlot({ nowMs: MON, tz: TZ, rules: cap1, existingUtcMs: [Date.parse('2026-07-20T15:00:00Z')] });
    expect(new Date(r.scheduledAtUtc!).toISOString()).toBe('2026-07-21T13:00:00.000Z'); // Tue 09:00 EDT
  });
  it('is deterministic and blocks when no weekday is allowed', () => {
    const a = computeNextSlot({ nowMs: MON, tz: TZ, rules, existingUtcMs: [] });
    const b = computeNextSlot({ nowMs: MON, tz: TZ, rules, existingUtcMs: [] });
    expect(a.scheduledAtUtc).toBe(b.scheduledAtUtc);
    expect(computeNextSlot({ nowMs: MON, tz: TZ, rules: { ...rules, allowedWeekdays: [] }, existingUtcMs: [] }).ok).toBe(false);
  });
});

describe('isSlotAllowed', () => {
  const now = MON;
  it('accepts a valid in-window weekday slot', () => {
    expect(isSlotAllowed({ atMs: Date.parse('2026-07-20T14:00:00Z'), nowMs: now, tz: TZ, rules, otherActiveUtcMs: [] }).ok).toBe(true);
  });
  it('rejects past/early, weekend, outside-window, too-close, over-cap', () => {
    expect(isSlotAllowed({ atMs: now + 60_000, nowMs: now, tz: TZ, rules, otherActiveUtcMs: [] }).reason).toBe('before_earliest');
    expect(isSlotAllowed({ atMs: Date.parse('2026-07-18T14:00:00Z'), nowMs: SAT - 86_400_000, tz: TZ, rules, otherActiveUtcMs: [] }).reason).toBe('weekday_not_allowed');
    expect(isSlotAllowed({ atMs: Date.parse('2026-07-20T23:00:00Z'), nowMs: now, tz: TZ, rules, otherActiveUtcMs: [] }).reason).toBe('outside_window'); // 19:00 EDT
    expect(isSlotAllowed({ atMs: Date.parse('2026-07-20T14:00:00Z'), nowMs: now, tz: TZ, rules, otherActiveUtcMs: [Date.parse('2026-07-20T14:10:00Z')] }).reason).toBe('too_close');
    expect(isSlotAllowed({ atMs: Date.parse('2026-07-20T14:00:00Z'), nowMs: now, tz: TZ, rules: { ...rules, dailyCap: 1 }, otherActiveUtcMs: [Date.parse('2026-07-20T09:30:00Z')] }).reason).toBe('daily_cap');
  });
});

describe('eligibility + fingerprint', () => {
  const base = (): ScheduleEligibilitySnapshot => ({
    leadStatus: 'DRAFT_CREATED', gmailDraft: { outcome: 'DRAFT_CREATED', providerDraftId: 'draft-abc' },
    finalizedContentHash: 'hash1', recipientEmail: 'contact@example.com', timezone: TZ, featureEnabled: true, hasActiveSchedule: false,
  });
  it('passes when all conditions hold', () => { expect(checkScheduleEligibility(base()).eligible).toBe(true); });
  it('fails closed; missing/invalid timezone flags a timezone problem', () => {
    expect(checkScheduleEligibility({ ...base(), leadStatus: 'SCHEDULED' }).eligible).toBe(false);
    expect(checkScheduleEligibility({ ...base(), gmailDraft: { outcome: 'DRAFT_CREATED', providerDraftId: null } }).eligible).toBe(false);
    expect(checkScheduleEligibility({ ...base(), recipientEmail: null }).reasons).toContain('no_verified_recipient');
    expect(checkScheduleEligibility({ ...base(), timezone: null }).timezoneProblem).toBe(true);
    expect(checkScheduleEligibility({ ...base(), timezone: 'Bad/Zone' }).timezoneProblem).toBe(true);
  });
  it('active schedule is a reuse', () => { expect(checkScheduleEligibility({ ...base(), hasActiveSchedule: true }).duplicateReusable).toBe(true); });
  it('fingerprint changes when any bound value changes', () => {
    const b = { leadId: 'l1', gmailDraftId: 'g1', providerDraftId: 'd1', finalizedContentHash: 'h1', recipientEmail: 'a@example.com', scheduledAtUtcMs: MON, rulesVersion: 'v1' };
    const base1 = scheduleIntegrityFingerprint(b);
    expect(scheduleIntegrityFingerprint({ ...b, recipientEmail: 'b@example.com' })).not.toBe(base1);
    expect(scheduleIntegrityFingerprint({ ...b, finalizedContentHash: 'h2' })).not.toBe(base1);
    expect(scheduleIntegrityFingerprint({ ...b, scheduledAtUtcMs: MON + 1000 })).not.toBe(base1);
  });
});

// --- Service (fake store/uow, injected clock) ---

const logger = pino({ level: 'silent' });
const cfg: ScheduleConfig = { featureEnabled: true, rules, rulesVersion: 'sched-rules-1' };
interface Cap { transitions: string[]; inserts: ScheduleRecord[]; supersedes: [string, string][]; cancels: [string, string | null][]; }
function fakeUow(cap: Cap, leadStatus = 'DRAFT_CREATED'): ScheduleUnitOfWork {
  return {
    async transaction(fn) {
      return fn({
        leads: { async getById() { return { id: 'l1', status: leadStatus } as never; } } as never,
        leadService: { async transition(_id: string, to: string) { cap.transitions.push(to); } } as never,
        insert: async (row) => { cap.inserts.push(row); },
        supersede: async (oldId, newId) => { cap.supersedes.push([oldId, newId]); },
        cancel: async (id, reason) => { cap.cancels.push([id, reason]); },
        events: { async record() { /* noop */ } },
      } as ScheduleTxRepos);
    },
  };
}
function fakeStore(over: Partial<ScheduleStore> = {}): ScheduleStore {
  return { async activeScheduledUtc() { return []; }, async activeForDraft() { return null; }, async activeForLead() { return null; }, ...over };
}
const input = (over: Partial<ScheduleInput> = {}): ScheduleInput => ({
  leadId: 'l1', leadStatus: 'DRAFT_CREATED', gmailDraft: { id: 'g1', outcome: 'DRAFT_CREATED', providerDraftId: 'draft-abc' },
  finalizedContentHash: 'hash1', recipientEmail: 'contact@example.com', timezone: TZ, ...over,
});
const svc = (cap: Cap, store = fakeStore(), leadStatus = 'DRAFT_CREATED') =>
  new ScheduleService({ store, uow: fakeUow(cap, leadStatus), logger, config: cfg, now: () => MON });

describe('ScheduleService', () => {
  it('schedules and transitions DRAFT_CREATED → SCHEDULED', async () => {
    const cap: Cap = { transitions: [], inserts: [], supersedes: [], cancels: [] };
    const r = await svc(cap).schedule(input(), 'run-1');
    expect(r.outcome).toBe('SCHEDULED');
    expect(r.scheduledAtUtc).toBe('2026-07-20T13:00:00.000Z');
    expect(cap.inserts).toHaveLength(1);
    expect(cap.inserts[0]?.status).toBe('SCHEDULED');
    expect(cap.transitions).toEqual(['SCHEDULED']);
  });
  it('dry-run computes the slot but writes nothing', async () => {
    const cap: Cap = { transitions: [], inserts: [], supersedes: [], cancels: [] };
    const r = await svc(cap).schedule(input(), '', { dryRun: true });
    expect(r.outcome).toBe('SCHEDULED_DRYRUN');
    expect(r.scheduledAtUtc).toBe('2026-07-20T13:00:00.000Z');
    expect(r.scheduledAtLocal).toContain('America/New_York');
    expect(cap.inserts).toHaveLength(0);
    expect(cap.transitions).toEqual([]);
  });
  it('reuses an active schedule (DUPLICATE_REUSED)', async () => {
    const cap: Cap = { transitions: [], inserts: [], supersedes: [], cancels: [] };
    const activeRec = { id: 's1', scheduledAtUtc: new Date('2026-07-20T13:00:00Z'), timezone: TZ } as ScheduleRecord;
    const r = await svc(cap, fakeStore({ async activeForDraft() { return activeRec; } })).schedule(input(), 'run-1');
    expect(r.outcome).toBe('DUPLICATE_REUSED');
    expect(cap.inserts).toHaveLength(0);
  });
  it('invalid timezone routes to manual review (TIMEZONE_INVALID)', async () => {
    const cap: Cap = { transitions: [], inserts: [], supersedes: [], cancels: [] };
    const r = await svc(cap).schedule(input({ timezone: 'Bad/Zone' }), 'run-1');
    expect(r.outcome).toBe('TIMEZONE_INVALID');
    expect(cap.transitions).toEqual(['NEEDS_MANUAL_REVIEW']);
    expect(cap.inserts).toHaveLength(0);
  });
  it('cancel: SCHEDULED → DRAFT_CREATED, preserves the row', async () => {
    const cap: Cap = { transitions: [], inserts: [], supersedes: [], cancels: [] };
    const activeRec = { id: 's1', scheduledAtUtc: new Date('2026-07-20T13:00:00Z'), timezone: TZ } as ScheduleRecord;
    const r = await svc(cap, fakeStore({ async activeForLead() { return activeRec; } }), 'SCHEDULED').cancel('l1', 'operator changed mind', 'run-1');
    expect(r.outcome).toBe('CANCELLED');
    expect(cap.cancels).toEqual([['s1', 'operator changed mind']]);
    expect(cap.transitions).toEqual(['DRAFT_CREATED']);
  });
  it('cancel with no active schedule is a NOOP (NOT_SCHEDULED)', async () => {
    const cap: Cap = { transitions: [], inserts: [], supersedes: [], cancels: [] };
    expect((await svc(cap).cancel('l1', null, 'run-1')).outcome).toBe('NOT_SCHEDULED');
  });
  it('reschedule supersedes the old row and inserts a new active one', async () => {
    const cap: Cap = { transitions: [], inserts: [], supersedes: [], cancels: [] };
    const activeRec = { id: 's1', gmailDraftId: 'g1', providerDraftId: 'draft-abc', scheduledAtUtc: new Date('2026-07-20T13:00:00Z'), timezone: TZ, rescheduleCount: 0 } as ScheduleRecord;
    const store = fakeStore({ async activeForLead() { return activeRec; }, async activeScheduledUtc() { return [new Date('2026-07-20T13:00:00Z')]; } });
    const r = await svc(cap, store, 'SCHEDULED').reschedule(input({ leadStatus: 'SCHEDULED' }), '2026-07-21T14:00:00Z', 'run-1');
    expect(r.outcome).toBe('RESCHEDULED');
    expect(cap.inserts).toHaveLength(1);
    expect(cap.inserts[0]?.rescheduleCount).toBe(1);
    expect(cap.supersedes[0]?.[0]).toBe('s1');
  });
  it('reschedule to a bad time is rejected (INVALID_SCHEDULE)', async () => {
    const cap: Cap = { transitions: [], inserts: [], supersedes: [], cancels: [] };
    const activeRec = { id: 's1', gmailDraftId: 'g1', providerDraftId: 'draft-abc', scheduledAtUtc: new Date('2026-07-20T13:00:00Z'), timezone: TZ, rescheduleCount: 0 } as ScheduleRecord;
    const r = await svc(cap, fakeStore({ async activeForLead() { return activeRec; } }), 'SCHEDULED').reschedule(input({ leadStatus: 'SCHEDULED' }), '2026-07-20T23:00:00Z', 'run-1');
    expect(r.outcome).toBe('INVALID_SCHEDULE'); // 19:00 EDT, outside window
    expect(cap.inserts).toHaveLength(0);
  });
});
