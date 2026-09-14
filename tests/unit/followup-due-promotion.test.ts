import { describe, expect, it } from 'vitest';
import {
  decideFollowupPromotion,
  runFollowupDuePromotion,
  type FollowupPromotionCandidateView,
  type FollowupPromotionDeps,
  type PromoteResult,
} from '../../src/domain/outreach/followup-due-promotion.js';

/**
 * Due-state promotion: the phase that lets the sequence advance WITHOUT an operator hand-typing a
 * state transition for every record. The properties that matter are that it advances a record only
 * when a real, active, actually-due follow-up row says so; that it advances it exactly one legal
 * hop; that every suppression signal still stops it; and that a repeated timer run writes nothing.
 */

const NOW = Date.parse('2026-09-14T10:00:00Z');
const DUE = Date.parse('2026-09-14T09:00:00Z');

const candidate = (over: Partial<FollowupPromotionCandidateView> = {}): FollowupPromotionCandidateView => ({
  followupId: 'f1',
  outreachRecordId: 'rec-1',
  leadId: 'lead-1',
  step: 1,
  followupStatus: 'DUE',
  dueAtMs: DUE,
  recordStatus: 'INITIAL_SENT',
  doNotContact: false,
  ...over,
});

describe('promotion decision — which record may announce a follow-up as due', () => {
  it('promotes step 1 from INITIAL_SENT, the state an initial send leaves behind', () => {
    expect(decideFollowupPromotion(candidate(), NOW)).toEqual({
      action: 'PROMOTE', step: 1, from: 'INITIAL_SENT', to: 'FOLLOW_UP_1_DUE',
    });
  });

  it('promotes step 2 only from FOLLOW_UP_1_SENT', () => {
    expect(decideFollowupPromotion(candidate({ step: 2, recordStatus: 'FOLLOW_UP_1_SENT' }), NOW)).toEqual({
      action: 'PROMOTE', step: 2, from: 'FOLLOW_UP_1_SENT', to: 'FOLLOW_UP_2_DUE',
    });
  });

  it('promotes step 3 only from FOLLOW_UP_2_SENT', () => {
    expect(decideFollowupPromotion(candidate({ step: 3, recordStatus: 'FOLLOW_UP_2_SENT' }), NOW)).toEqual({
      action: 'PROMOTE', step: 3, from: 'FOLLOW_UP_2_SENT', to: 'FOLLOW_UP_3_DUE',
    });
  });

  it('never promotes before the due instant', () => {
    const d = decideFollowupPromotion(candidate({ dueAtMs: NOW + 60_000 }), NOW);
    expect(d.action).toBe('SKIP');
    expect(d.action === 'SKIP' && d.reason).toBe('NOT_YET_DUE');
  });

  it('promotes exactly at the due instant (the boundary is inclusive, like the due query)', () => {
    expect(decideFollowupPromotion(candidate({ dueAtMs: NOW }), NOW).action).toBe('PROMOTE');
  });

  it.each(['CANCELLED', 'POSTPONED', 'SENT'] as const)('never promotes on a %s follow-up row', (status) => {
    const d = decideFollowupPromotion(candidate({ followupStatus: status }), NOW);
    expect(d.action).toBe('SKIP');
    expect(d.action === 'SKIP' && d.reason).toBe('FOLLOWUP_NOT_ACTIVE');
  });

  it.each([
    ['REPLIED_POSITIVE', 'REPLY_DETECTED'],
    ['REPLIED_NEUTRAL', 'REPLY_DETECTED'],
    ['REPLIED_NEGATIVE', 'REPLY_DETECTED'],
    ['BOUNCED', 'BOUNCED'],
    ['UNSUBSCRIBED', 'UNSUBSCRIBED'],
    ['DO_NOT_CONTACT', 'DO_NOT_CONTACT'],
    ['MEETING_BOOKED', 'MEETING_BOOKED'],
    ['CLOSED_WON', 'CLOSED'],
    ['CLOSED_LOST', 'CLOSED'],
  ] as const)('blocks a %s record', (recordStatus, reason) => {
    const d = decideFollowupPromotion(candidate({ recordStatus }), NOW);
    expect(d.action).toBe('BLOCKED');
    expect(d.action === 'BLOCKED' && d.reason).toBe(reason);
  });

  it('blocks a do-not-contact contact even while the record status still looks promotable', () => {
    const d = decideFollowupPromotion(candidate({ doNotContact: true }), NOW);
    expect(d.action).toBe('BLOCKED');
    expect(d.action === 'BLOCKED' && d.reason).toBe('DO_NOT_CONTACT');
  });

  it('reports suppression rather than idempotency when a reply lands on an already-promoted record', () => {
    // Order matters: a replied record must never be reported as a benign "already due" no-op.
    const d = decideFollowupPromotion(candidate({ recordStatus: 'REPLIED_POSITIVE' }), NOW);
    expect(d.action).toBe('BLOCKED');
  });

  it('is idempotent: a record already at the step’s due status is left untouched', () => {
    const d = decideFollowupPromotion(candidate({ recordStatus: 'FOLLOW_UP_1_DUE' }), NOW);
    expect(d.action).toBe('ALREADY_DUE');
  });

  it.each([
    // A step-2 row while the record has not yet sent follow-up 1: promoting would skip an email.
    [2, 'INITIAL_SENT'],
    // A step-1 row on a record that is already mid-sequence.
    [1, 'FOLLOW_UP_2_SENT'],
    // A record still awaiting a DIFFERENT step.
    [2, 'FOLLOW_UP_1_DUE'],
    // Nothing has been sent at all yet.
    [1, 'APPROVED_TO_SEND'],
  ] as const)('refuses step %i when the record is %s', (step, recordStatus) => {
    const d = decideFollowupPromotion(candidate({ step, recordStatus }), NOW);
    expect(d.action).toBe('SKIP');
    expect(d.action === 'SKIP' && d.reason).toBe('STATUS_MISMATCH');
  });

  it('refuses a malformed step before anything else can reason about it', () => {
    const d = decideFollowupPromotion(candidate({ step: 4 }), NOW);
    expect(d.action).toBe('SKIP');
    expect(d.action === 'SKIP' && d.reason).toBe('UNKNOWN_STEP');
  });

  it('refuses a row whose record could not be resolved', () => {
    const d = decideFollowupPromotion(candidate({ recordStatus: null }), NOW);
    expect(d.action).toBe('SKIP');
    expect(d.action === 'SKIP' && d.reason).toBe('NO_OUTREACH_RECORD');
  });
});

function harness(opts: {
  gates?: Partial<FollowupPromotionDeps['gates']>;
  candidates?: FollowupPromotionCandidateView[];
  result?: PromoteResult;
  throws?: boolean;
} = {}) {
  const promoteCalls: string[] = [];
  const listed: number[] = [];
  const deps: FollowupPromotionDeps = {
    now: () => NOW,
    gates: { followupPromotionEnabled: true, outreachTrackingEnabled: true, ...opts.gates },
    maxPerRun: 5,
    candidates: async (_now, limit) => { listed.push(limit); return opts.candidates ?? []; },
    promote: async (c) => {
      promoteCalls.push(c.outreachRecordId);
      if (opts.throws) throw new Error('db exploded');
      return opts.result ?? { promoted: true, outcome: 'PROMOTED: promoted to FOLLOW_UP_1_DUE' };
    },
  };
  return { deps, promoteCalls, listed };
}

describe('promotion runner — gates, bounds, and isolation', () => {
  it('is OFF by default: the master gate stops it before any candidate is listed', async () => {
    const h = harness({ gates: { followupPromotionEnabled: false }, candidates: [candidate()] });
    const r = await runFollowupDuePromotion(h.deps);
    expect(r.outcome).toBe('MASTER_DISABLED');
    expect(h.listed).toEqual([]);
    expect(h.promoteCalls).toEqual([]);
  });

  it('refuses to run without outreach tracking', async () => {
    const h = harness({ gates: { outreachTrackingEnabled: false }, candidates: [candidate()] });
    const r = await runFollowupDuePromotion(h.deps);
    expect(r.outcome).toBe('TRACKING_DISABLED');
    expect(h.promoteCalls).toEqual([]);
  });

  it('promotes a due candidate and reports it', async () => {
    const h = harness({ candidates: [candidate()] });
    const r = await runFollowupDuePromotion(h.deps);
    expect(r.outcome).toBe('RAN');
    expect(r.considered).toBe(1);
    expect(r.promoted).toHaveLength(1);
    expect(h.promoteCalls).toEqual(['rec-1']);
  });

  it('bounds the worklist by maxPerRun', async () => {
    const h = harness({ candidates: [] });
    await runFollowupDuePromotion(h.deps);
    expect(h.listed).toEqual([5]);
  });

  it('never attempts a write for a blocked or skipped candidate', async () => {
    const h = harness({
      candidates: [
        candidate({ followupId: 'f-replied', recordStatus: 'REPLIED_POSITIVE' }),
        candidate({ followupId: 'f-early', dueAtMs: NOW + 1 }),
        candidate({ followupId: 'f-cancelled', followupStatus: 'CANCELLED' }),
        candidate({ followupId: 'f-mismatch', step: 2 }),
      ],
    });
    const r = await runFollowupDuePromotion(h.deps);
    expect(h.promoteCalls).toEqual([]);
    expect(r.blocked).toHaveLength(1);
    expect(r.skipped).toHaveLength(3);
    expect(r.promoted).toEqual([]);
  });

  it('a repeated run over an already-promoted record writes nothing and reports no failure', async () => {
    const h = harness({ candidates: [candidate({ recordStatus: 'FOLLOW_UP_1_DUE' })] });
    const r = await runFollowupDuePromotion(h.deps);
    expect(h.promoteCalls).toEqual([]);
    expect(r.unchanged).toHaveLength(1);
    expect(r.failures).toEqual([]);
  });

  it('treats a refused write (a lost race, or state that moved) as unchanged, not as an error', async () => {
    const h = harness({
      candidates: [candidate()],
      result: { promoted: false, outcome: 'RACE_LOST: record left INITIAL_SENT before the promotion could be applied' },
    });
    const r = await runFollowupDuePromotion(h.deps);
    expect(r.promoted).toEqual([]);
    expect(r.unchanged).toHaveLength(1);
    expect(r.failures).toEqual([]);
  });

  it('a throwing candidate is reported and never stalls the rest of the queue', async () => {
    const h = harness({ candidates: [candidate(), candidate({ followupId: 'f2', outreachRecordId: 'rec-2' })], throws: true });
    const r = await runFollowupDuePromotion(h.deps);
    expect(h.promoteCalls).toEqual(['rec-1', 'rec-2']);
    expect(r.failures).toHaveLength(2);
    expect(r.failures[0]?.detail).toContain('db exploded');
  });
});
