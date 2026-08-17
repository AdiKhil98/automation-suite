import { describe, expect, it } from 'vitest';
import {
  runScheduledSends,
  type EnrollmentOutcome,
  type ScheduledRunDeps,
  type ScheduledRunGates,
  type SendOneResult,
} from '../../src/domain/send/scheduled-send-runner.js';

const OPEN_GATES: ScheduledRunGates = {
  scheduledSendEnabled: true, sendingEnabled: true, outboundActionsEnabled: true,
  dryRun: false, providerIsHttp: true, outreachTrackingEnabled: true,
};

interface Harness {
  deps: ScheduledRunDeps;
  calls: { mint: number; sent: string[]; enrolled: Array<[string, string]> };
}

function harness(opts: {
  gates?: Partial<ScheduledRunGates>;
  auth?: { id: string; maxPerDay: number } | null;
  sentToday?: number;
  sendingDailyCap?: number;
  due?: string[];
  sendResults?: Record<string, SendOneResult>;
  enroll?: EnrollmentOutcome;
  /** Per-attempt enrollment outcome (keyed by attempt id), for both recovery and the send loop. */
  enrollResults?: Record<string, EnrollmentOutcome>;
  /** Confirmed-but-unenrolled attempts the recovery sweep should heal. */
  unenrolled?: Array<{ leadId: string; attemptId: string }>;
} = {}): Harness {
  const calls = { mint: 0, sent: [] as string[], enrolled: [] as Array<[string, string]> };
  const due = opts.due ?? ['lead-a', 'lead-b', 'lead-c'];
  const enrollResults = opts.enrollResults ?? {};
  const deps: ScheduledRunDeps = {
    now: () => 1_000,
    gates: { ...OPEN_GATES, ...opts.gates },
    sendingDailyCap: opts.sendingDailyCap ?? 2,
    findUnenrolledConfirmedSends: async () => opts.unenrolled ?? [],
    getValidAuthorization: async () => (opts.auth === undefined ? { id: 'auth-1', maxPerDay: 2 } : opts.auth),
    confirmedSendsToday: async () => opts.sentToday ?? 0,
    mintSessionReadiness: async () => { calls.mint += 1; },
    dueScheduledLeadIds: async (_now, limit) => due.slice(0, limit),
    sendOne: async (leadId) => {
      calls.sent.push(leadId);
      return opts.sendResults?.[leadId] ?? { outcome: 'SENT_CONFIRMED', attemptId: `att-${leadId}` };
    },
    enroll: async (leadId, attemptId) => {
      calls.enrolled.push([leadId, attemptId]);
      return enrollResults[attemptId] ?? opts.enroll ?? 'ENROLLED';
    },
  };
  return { deps, calls };
}

describe('runScheduledSends fail-closed gates', () => {
  it('MASTER_DISABLED when the master switch is off (nothing minted or sent)', async () => {
    const h = harness({ gates: { scheduledSendEnabled: false } });
    const r = await runScheduledSends(h.deps);
    expect(r.outcome).toBe('MASTER_DISABLED');
    expect(h.calls.mint).toBe(0);
    expect(h.calls.sent).toEqual([]);
  });

  it('GATES_DISABLED when any global send gate is not armed', async () => {
    for (const gates of [{ sendingEnabled: false }, { outboundActionsEnabled: false }, { dryRun: true }, { providerIsHttp: false }]) {
      const h = harness({ gates });
      const r = await runScheduledSends(h.deps);
      expect(r.outcome, JSON.stringify(gates)).toBe('GATES_DISABLED');
      expect(h.calls.mint).toBe(0);
    }
  });

  it('TRACKING_DISABLED when outreach tracking is off (enrollment is mandatory)', async () => {
    const h = harness({ gates: { outreachTrackingEnabled: false } });
    expect((await runScheduledSends(h.deps)).outcome).toBe('TRACKING_DISABLED');
    expect(h.calls.mint).toBe(0);
  });

  it('NO_AUTHORIZATION when there is no valid durable authorization (no readiness minted)', async () => {
    const h = harness({ auth: null });
    const r = await runScheduledSends(h.deps);
    expect(r.outcome).toBe('NO_AUTHORIZATION');
    expect(h.calls.mint).toBe(0);
    expect(h.calls.sent).toEqual([]);
  });

  it('CAP_REACHED when the day is already at cap (no readiness minted, no send)', async () => {
    const h = harness({ sentToday: 2 });
    const r = await runScheduledSends(h.deps);
    expect(r.outcome).toBe('CAP_REACHED');
    expect(r.capacity).toBe(0);
    expect(h.calls.mint).toBe(0);
    expect(h.calls.sent).toEqual([]);
  });
});

describe('runScheduledSends execution', () => {
  it('mints session readiness once and sends up to capacity, auto-enrolling each confirmed send', async () => {
    const h = harness({ due: ['lead-a', 'lead-b', 'lead-c'] }); // cap 2 → only 2 attempted
    const r = await runScheduledSends(h.deps);
    expect(r.outcome).toBe('RAN');
    expect(r.capacity).toBe(2);
    expect(h.calls.mint).toBe(1);
    expect(h.calls.sent).toEqual(['lead-a', 'lead-b']);
    expect(r.sent.map((s) => s.leadId)).toEqual(['lead-a', 'lead-b']);
    expect(r.sent.every((s) => s.enrollment === 'ENROLLED')).toBe(true);
    expect(h.calls.enrolled).toEqual([['lead-a', 'att-lead-a'], ['lead-b', 'att-lead-b']]);
  });

  it('honours the lesser of account cap and authorization cap minus what was already sent', async () => {
    const h = harness({ sendingDailyCap: 5, auth: { id: 'auth-1', maxPerDay: 2 }, sentToday: 1, due: ['lead-a', 'lead-b'] });
    const r = await runScheduledSends(h.deps);
    expect(r.capacity).toBe(1); // min(5,2) - 1
    expect(h.calls.sent).toEqual(['lead-a']);
  });

  it('STOPS on the first OUTCOME_UNKNOWN and never retries or attempts further leads', async () => {
    const h = harness({
      due: ['lead-a', 'lead-b'],
      sendResults: { 'lead-a': { outcome: 'OUTCOME_UNKNOWN', attemptId: 'att-a' } },
    });
    const r = await runScheduledSends(h.deps);
    expect(r.outcome).toBe('RAN');
    expect(h.calls.sent).toEqual(['lead-a']); // lead-b never attempted
    expect(r.unknown).toEqual([{ leadId: 'lead-a', attemptId: 'att-a' }]);
    expect(r.sent).toEqual([]);
    expect(h.calls.enrolled).toEqual([]);
  });

  it('records a definitive failure and continues to the next lead', async () => {
    const h = harness({
      due: ['lead-a', 'lead-b'],
      sendResults: { 'lead-a': { outcome: 'DEFINITIVE_FAILURE', attemptId: null, reason: 'auth_error' } },
    });
    const r = await runScheduledSends(h.deps);
    expect(h.calls.sent).toEqual(['lead-a', 'lead-b']);
    expect(r.failures).toEqual([{ leadId: 'lead-a', outcome: 'DEFINITIVE_FAILURE', reason: 'auth_error' }]);
    expect(r.sent.map((s) => s.leadId)).toEqual(['lead-b']);
  });

  it('flags a failed enrollment on an otherwise-confirmed send (healed by the next run recovery)', async () => {
    const h = harness({ due: ['lead-a'], enroll: 'ENROLL_FAILED' });
    const r = await runScheduledSends(h.deps);
    expect(r.sent).toEqual([{ leadId: 'lead-a', attemptId: 'att-lead-a', enrollment: 'ENROLL_FAILED' }]);
  });
});

describe('runScheduledSends self-healing recovery (never sends)', () => {
  it('enrolls a confirmed-but-unenrolled send on the NEXT run without sending again', async () => {
    // Prior run confirmed lead-a but enrollment failed; this run has no new due leads.
    const h = harness({ unenrolled: [{ leadId: 'lead-a', attemptId: 'att-a' }], due: [] });
    const r = await runScheduledSends(h.deps);
    expect(r.recovered).toEqual([{ leadId: 'lead-a', attemptId: 'att-a', outcome: 'ENROLLED' }]);
    expect(h.calls.enrolled).toEqual([['lead-a', 'att-a']]);
    expect(h.calls.sent).toEqual([]); // recovery NEVER sends
  });

  it('is idempotent — an already-enrolled attempt is treated as recovered, not a failure', async () => {
    const h = harness({ unenrolled: [{ leadId: 'lead-a', attemptId: 'att-a' }], enrollResults: { 'att-a': 'ALREADY_ENROLLED' }, due: [] });
    const r = await runScheduledSends(h.deps);
    expect(r.recovered).toEqual([{ leadId: 'lead-a', attemptId: 'att-a', outcome: 'ALREADY_ENROLLED' }]);
    expect(r.recoveryFailures).toEqual([]);
    expect(h.calls.sent).toEqual([]);
  });

  it('surfaces a recovery failure without ever resending', async () => {
    const h = harness({ unenrolled: [{ leadId: 'lead-a', attemptId: 'att-a' }], enrollResults: { 'att-a': 'ENROLL_FAILED' }, due: [] });
    const r = await runScheduledSends(h.deps);
    expect(r.recoveryFailures).toEqual([{ leadId: 'lead-a', attemptId: 'att-a', outcome: 'ENROLL_FAILED' }]);
    expect(r.recovered).toEqual([]);
    expect(h.calls.sent).toEqual([]);
  });

  it('runs recovery even when the master switch is off (heals a paused/crashed prior run; no send)', async () => {
    const h = harness({ gates: { scheduledSendEnabled: false }, unenrolled: [{ leadId: 'lead-a', attemptId: 'att-a' }] });
    const r = await runScheduledSends(h.deps);
    expect(r.outcome).toBe('MASTER_DISABLED');
    expect(r.recovered).toEqual([{ leadId: 'lead-a', attemptId: 'att-a', outcome: 'ENROLLED' }]);
    expect(h.calls.sent).toEqual([]);
    expect(h.calls.mint).toBe(0);
  });

  it('skips recovery when outreach tracking is disabled (cannot enroll)', async () => {
    const h = harness({ gates: { outreachTrackingEnabled: false }, unenrolled: [{ leadId: 'lead-a', attemptId: 'att-a' }] });
    const r = await runScheduledSends(h.deps);
    expect(r.outcome).toBe('TRACKING_DISABLED');
    expect(r.recovered).toEqual([]);
    expect(r.recoveryFailures).toEqual([]);
    expect(h.calls.enrolled).toEqual([]);
  });

  it('recovers AND then sends in the same run (recovery first, then the send loop)', async () => {
    const h = harness({ unenrolled: [{ leadId: 'old', attemptId: 'att-old' }], due: ['lead-a'] });
    const r = await runScheduledSends(h.deps);
    expect(r.recovered).toEqual([{ leadId: 'old', attemptId: 'att-old', outcome: 'ENROLLED' }]);
    expect(r.sent.map((s) => s.leadId)).toEqual(['lead-a']);
    // enroll called for the recovered attempt first, then the freshly-sent lead.
    expect(h.calls.enrolled).toEqual([['old', 'att-old'], ['lead-a', 'att-lead-a']]);
  });
});
