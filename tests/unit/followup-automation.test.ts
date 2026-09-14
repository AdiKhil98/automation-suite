import { describe, expect, it } from 'vitest';
import {
  decideFollowupPreparation,
  runFollowupPreparation,
  type ComposeResult,
  type FollowupCandidateView,
  type FollowupPreparationDeps,
} from '../../src/domain/outreach/followup-preparation-runner.js';
import {
  decideProgression,
  runFollowupProgression,
  type FollowupProgressionDeps,
  type ProgressionCandidateView,
  type StageResult,
} from '../../src/domain/outreach/followup-progression-runner.js';

/**
 * The two unattended runners. The properties that matter for running these on a timer are: they
 * never send, they never bypass human approval, repeated runs never duplicate work, and authoritative
 * suppression stops them at every phase.
 */

const candidate = (over: Partial<FollowupCandidateView> = {}): FollowupCandidateView => ({
  followupId: 'f1',
  outreachRecordId: 'rec-1',
  leadId: 'lead-1',
  step: 1,
  recordStatus: 'FOLLOW_UP_1_DUE',
  doNotContact: false,
  leadStatus: 'SENT',
  existingDraft: null,
  // The pending row is newer than nothing by default; a rejected draft older than it means the
  // operator rescheduled the step and wants fresh copy.
  followupCreatedAtMs: 1_000,
  ...over,
});

describe('preparation decision — what a due follow-up is allowed to do', () => {
  it('composes a due, unsuppressed, not-yet-prepared follow-up', () => {
    expect(decideFollowupPreparation(candidate())).toEqual({ action: 'COMPOSE', step: 1 });
  });

  it('blocks on authoritative suppression before anything else', () => {
    for (const status of ['REPLIED_POSITIVE', 'BOUNCED', 'UNSUBSCRIBED', 'DO_NOT_CONTACT', 'MEETING_BOOKED', 'CLOSED_WON'] as const) {
      const d = decideFollowupPreparation(candidate({ recordStatus: status }));
      expect(d.action).toBe('BLOCKED');
    }
    expect(decideFollowupPreparation(candidate({ doNotContact: true })).action).toBe('BLOCKED');
  });

  it('reports suppression even when copy was already composed', () => {
    // Suppression must win over the idempotency shortcut: a prospect who replied is reported as
    // blocked, not quietly skipped as "already prepared".
    const d = decideFollowupPreparation(candidate({
      recordStatus: 'REPLIED_NEUTRAL', existingDraft: { id: 'e1', humanDecision: null, createdAtMs: 2_000 },
    }));
    expect(d.action).toBe('BLOCKED');
  });

  it('is idempotent: an already-composed follow-up awaiting review is skipped', () => {
    const d = decideFollowupPreparation(candidate({ existingDraft: { id: 'e1', humanDecision: null, createdAtMs: 2_000 } }));
    expect(d).toEqual({ action: 'SKIP', reason: 'AWAITING_HUMAN_REVIEW', detail: 'draft e1 is waiting for a human decision' });
  });

  it('skips copy a human already approved (progression owns it)', () => {
    const d = decideFollowupPreparation(candidate({ existingDraft: { id: 'e1', humanDecision: 'APPROVED', createdAtMs: 2_000 } }));
    expect(d.action).toBe('SKIP');
    expect(d.action === 'SKIP' && d.reason).toBe('ALREADY_PREPARED');
  });

  it('cancels the pending row when a human rejected the copy', () => {
    const d = decideFollowupPreparation(candidate({ existingDraft: { id: 'e1', humanDecision: 'REJECTED', createdAtMs: 2_000 } }));
    expect(d.action).toBe('CANCEL_REJECTED');
  });

  it('refuses to compose unless the lead is at the SENT re-entry point', () => {
    const d = decideFollowupPreparation(candidate({ leadStatus: 'READY_FOR_HUMAN_APPROVAL' }));
    expect(d.action).toBe('SKIP');
    expect(d.action === 'SKIP' && d.reason).toBe('LEAD_NOT_AT_SEQUENCE_REENTRY');
  });

  it('refuses an unknown step before anything can reach the writer', () => {
    const d = decideFollowupPreparation(candidate({ step: 4 }));
    expect(d.action).toBe('SKIP');
    expect(d.action === 'SKIP' && d.reason).toBe('UNKNOWN_STEP');
  });
});

function prepHarness(opts: {
  gates?: Partial<FollowupPreparationDeps['gates']>;
  candidates?: FollowupCandidateView[];
  compose?: (c: FollowupCandidateView) => Promise<ComposeResult>;
} = {}) {
  const calls = { composed: [] as string[], cancelled: [] as string[] };
  const deps: FollowupPreparationDeps = {
    now: () => 1_000,
    gates: {
      followupPreparationEnabled: true, outreachTrackingEnabled: true, emailGenerationEnabled: true,
      ...opts.gates,
    },
    preflight: () => { /* provider config is a CLI concern; nothing to check here */ },
    maxPerRun: 5,
    dueCandidates: async () => opts.candidates ?? [candidate()],
    cancelFollowup: async (id) => { calls.cancelled.push(id); },
    compose: async (c) => {
      calls.composed.push(c.leadId);
      return opts.compose ? opts.compose(c) : { prepared: true, outcome: 'APPROVED_READY' };
    },
  };
  return { deps, calls };
}

describe('preparation runner — gates and idempotency', () => {
  it('is OFF by default: the master gate stops it before any work', async () => {
    const h = prepHarness({ gates: { followupPreparationEnabled: false } });
    const r = await runFollowupPreparation(h.deps);
    expect(r.outcome).toBe('MASTER_DISABLED');
    expect(h.calls.composed).toEqual([]);
    expect(r.considered).toBe(0);
  });

  it('refuses to run without outreach tracking or email generation', async () => {
    expect((await runFollowupPreparation(prepHarness({ gates: { outreachTrackingEnabled: false } }).deps)).outcome)
      .toBe('TRACKING_DISABLED');
    expect((await runFollowupPreparation(prepHarness({ gates: { emailGenerationEnabled: false } }).deps)).outcome)
      .toBe('EMAIL_GENERATION_DISABLED');
  });

  it('composes a due follow-up and reports it as awaiting human approval', async () => {
    const h = prepHarness();
    const r = await runFollowupPreparation(h.deps);
    expect(r.outcome).toBe('RAN');
    expect(r.prepared).toHaveLength(1);
    expect(h.calls.composed).toEqual(['lead-1']);
  });

  it('a repeated timer run composes nothing for the same follow-up', async () => {
    // Second run: the first run's draft is now present and awaiting review.
    const h = prepHarness({ candidates: [candidate({ existingDraft: { id: 'e1', humanDecision: null, createdAtMs: 2_000 } })] });
    const r = await runFollowupPreparation(h.deps);
    expect(h.calls.composed).toEqual([]);
    expect(r.prepared).toEqual([]);
    expect(r.skipped).toHaveLength(1);
  });

  it('cancels the pending row for rejected copy so the queue does not spin forever', async () => {
    const h = prepHarness({ candidates: [candidate({ existingDraft: { id: 'e1', humanDecision: 'REJECTED', createdAtMs: 2_000 } })] });
    const r = await runFollowupPreparation(h.deps);
    expect(h.calls.cancelled).toEqual(['f1']);
    expect(r.cancelled).toHaveLength(1);
    expect(h.calls.composed).toEqual([]);
  });

  it('records a composition that produced no approved copy as a failure, and continues', async () => {
    const h = prepHarness({
      candidates: [candidate({ leadId: 'lead-a' }), candidate({ leadId: 'lead-b', followupId: 'f2' })],
      compose: async (c) => (c.leadId === 'lead-a'
        ? { prepared: false, outcome: 'REVIEW_REJECTED' }
        : { prepared: true, outcome: 'APPROVED_READY' }),
    });
    const r = await runFollowupPreparation(h.deps);
    expect(r.failures).toHaveLength(1);
    expect(r.prepared).toHaveLength(1);
    expect(h.calls.composed).toEqual(['lead-a', 'lead-b']);
  });

  it('a throwing candidate never stalls the queue', async () => {
    const h = prepHarness({
      candidates: [candidate({ leadId: 'lead-a' }), candidate({ leadId: 'lead-b', followupId: 'f2' })],
      compose: async (c) => {
        if (c.leadId === 'lead-a') throw new Error('provider exploded');
        return { prepared: true, outcome: 'APPROVED_READY' };
      },
    });
    const r = await runFollowupPreparation(h.deps);
    expect(r.failures[0]?.detail).toContain('provider exploded');
    expect(r.prepared).toHaveLength(1);
  });
});

const prog = (over: Partial<ProgressionCandidateView> = {}): ProgressionCandidateView => ({
  leadId: 'lead-1',
  outreachRecordId: 'rec-1',
  emailDraftId: 'e1',
  sequenceStep: 1,
  leadStatus: 'HUMAN_APPROVED',
  humanDecision: 'APPROVED',
  hasFinalization: false,
  hasGmailDraft: false,
  hasActiveSchedule: false,
  recordStatus: 'FOLLOW_UP_1_DUE',
  doNotContact: false,
  ...over,
});

describe('progression decision — one stage at a time, in order', () => {
  it('walks finalize -> gmail draft -> schedule -> done', () => {
    expect(decideProgression(prog())).toEqual({ action: 'ADVANCE', stage: 'FINALIZE', step: 1 });
    expect(decideProgression(prog({ hasFinalization: true })))
      .toEqual({ action: 'ADVANCE', stage: 'CREATE_GMAIL_DRAFT', step: 1 });
    expect(decideProgression(prog({ hasFinalization: true, hasGmailDraft: true, leadStatus: 'DRAFT_CREATED' })))
      .toEqual({ action: 'ADVANCE', stage: 'SCHEDULE', step: 1 });
    expect(decideProgression(prog({ leadStatus: 'SCHEDULED', hasActiveSchedule: true })).action).toBe('DONE');
  });

  it('NEVER progresses without an explicit human approval', () => {
    for (const decision of [null, 'REJECTED']) {
      const d = decideProgression(prog({ humanDecision: decision }));
      expect(d.action).toBe('SKIP');
      expect(d.action === 'SKIP' && d.reason).toBe('NOT_HUMAN_APPROVED');
    }
  });

  it('never touches an initial send', () => {
    const d = decideProgression(prog({ sequenceStep: 0 }));
    expect(d.action).toBe('SKIP');
    expect(d.action === 'SKIP' && d.reason).toBe('NOT_A_FOLLOWUP');
  });

  it('re-checks suppression: a reply after approval stops the progression', () => {
    for (const status of ['REPLIED_POSITIVE', 'BOUNCED', 'UNSUBSCRIBED', 'DO_NOT_CONTACT', 'MEETING_BOOKED', 'CLOSED_LOST'] as const) {
      expect(decideProgression(prog({ recordStatus: status })).action).toBe('BLOCKED');
    }
    expect(decideProgression(prog({ doNotContact: true })).action).toBe('BLOCKED');
  });

  it('resumes at the missing stage after a crash', () => {
    // Finalization landed but the process died before the Gmail draft: the next run resumes there,
    // it does not redo the finalization and it does not skip ahead.
    expect(decideProgression(prog({ hasFinalization: true })))
      .toEqual({ action: 'ADVANCE', stage: 'CREATE_GMAIL_DRAFT', step: 1 });
  });

  it('fails closed on an unexpected lead state', () => {
    const d = decideProgression(prog({ leadStatus: 'NEEDS_MANUAL_REVIEW' }));
    expect(d.action).toBe('SKIP');
    expect(d.action === 'SKIP' && d.reason).toBe('UNEXPECTED_LEAD_STATE');
  });
});

function progHarness(opts: {
  gates?: Partial<FollowupProgressionDeps['gates']>;
  candidates?: ProgressionCandidateView[];
  stage?: (name: string) => Promise<StageResult>;
} = {}) {
  const calls: string[] = [];
  const run = (name: string) => async (): Promise<StageResult> => {
    calls.push(name);
    return opts.stage ? opts.stage(name) : { ok: true, detail: `${name} ok` };
  };
  const deps: FollowupProgressionDeps = {
    now: () => 1_000,
    gates: { followupProgressionEnabled: true, outreachTrackingEnabled: true, ...opts.gates },
    maxPerRun: 10,
    candidates: async () => opts.candidates ?? [prog()],
    finalize: run('FINALIZE'),
    createGmailDraft: run('CREATE_GMAIL_DRAFT'),
    schedule: run('SCHEDULE'),
  };
  return { deps, calls };
}

describe('progression runner — gates, ordering, idempotency', () => {
  it('is OFF by default', async () => {
    const h = progHarness({ gates: { followupProgressionEnabled: false } });
    const r = await runFollowupProgression(h.deps);
    expect(r.outcome).toBe('MASTER_DISABLED');
    expect(h.calls).toEqual([]);
  });

  it('requires outreach tracking', async () => {
    const h = progHarness({ gates: { outreachTrackingEnabled: false } });
    expect((await runFollowupProgression(h.deps)).outcome).toBe('TRACKING_DISABLED');
    expect(h.calls).toEqual([]);
  });

  it('executes exactly ONE stage per lead per run', async () => {
    const h = progHarness();
    const r = await runFollowupProgression(h.deps);
    expect(h.calls).toEqual(['FINALIZE']);
    expect(r.advanced).toHaveLength(1);
    expect(r.advanced[0]?.stage).toBe('FINALIZE');
  });

  it('does nothing at all for a lead already handed to the scheduler', async () => {
    const h = progHarness({ candidates: [prog({ leadStatus: 'SCHEDULED', hasActiveSchedule: true })] });
    const r = await runFollowupProgression(h.deps);
    expect(h.calls).toEqual([]);
    expect(r.done).toHaveLength(1);
  });

  it('surfaces a refused stage as a failure without advancing', async () => {
    const h = progHarness({ stage: async () => ({ ok: false, detail: 'finalization refused: draft_cta_not_reply' }) });
    const r = await runFollowupProgression(h.deps);
    expect(r.advanced).toEqual([]);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]?.detail).toContain('refused');
  });

  it('a throwing stage never stalls the other leads', async () => {
    const h = progHarness({
      candidates: [prog({ leadId: 'lead-a' }), prog({ leadId: 'lead-b' })],
      stage: async () => { throw new Error('db timeout'); },
    });
    const r = await runFollowupProgression(h.deps);
    expect(r.failures).toHaveLength(2);
    expect(r.failures[0]?.detail).toContain('db timeout');
  });

  it('never calls a stage for a suppressed or unapproved candidate', async () => {
    const h = progHarness({
      candidates: [prog({ recordStatus: 'REPLIED_POSITIVE' }), prog({ humanDecision: null })],
    });
    const r = await runFollowupProgression(h.deps);
    expect(h.calls).toEqual([]);
    expect(r.blocked).toHaveLength(1);
    expect(r.skipped).toHaveLength(1);
  });
});
