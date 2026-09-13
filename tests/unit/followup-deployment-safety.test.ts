import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  runFollowupPreparation,
  type FollowupCandidateView,
  type FollowupPreparationDeps,
} from '../../src/domain/outreach/followup-preparation-runner.js';

/**
 * Deployment-safety guards for unattended follow-up automation.
 *
 * Two distinct things are pinned here:
 *
 *  1. THE PAID-CALL GUARANTEE (runtime). Preparation may spend money at the model provider ONLY
 *     when a follow-up is genuinely due and eligible. Every other path — no candidates, suppressed,
 *     already prepared, lead not at the re-entry point — must reach the model provider zero times.
 *     The CLI builds the LLM provider lazily inside `compose`, so "compose was never called" is
 *     exactly equivalent to "no OpenAI client was constructed and no paid call was made".
 *
 *  2. THE SHIPPED SYSTEMD CONTRACT (static). The unit in deploy/systemd is the artifact production
 *     installs. These assertions fail loudly if someone reorders the inbox-freshness chain, arms a
 *     spend or send switch in version control, or reintroduces EnvironmentFile=.
 */

const UNIT = readFileSync(
  new URL('../../deploy/systemd/automation-suite-followups.service', import.meta.url),
  'utf8',
);
/** Directive lines only — the unit's comments discuss the very things we assert are absent. */
const DIRECTIVES = UNIT.split('\n').filter((l) => !l.trimStart().startsWith('#') && l.trim() !== '');

const candidate = (over: Partial<FollowupCandidateView> = {}): FollowupCandidateView => ({
  followupId: 'f1',
  outreachRecordId: 'rec-1',
  leadId: 'lead-1',
  step: 1,
  recordStatus: 'FOLLOW_UP_1_DUE',
  doNotContact: false,
  leadStatus: 'SENT',
  existingDraft: null,
  ...over,
});

function harness(opts: {
  gates?: Partial<FollowupPreparationDeps['gates']>;
  candidates?: FollowupCandidateView[];
} = {}) {
  const composeCalls: string[] = [];
  const deps: FollowupPreparationDeps = {
    now: () => 1_000,
    gates: {
      followupPreparationEnabled: true, outreachTrackingEnabled: true, emailGenerationEnabled: true,
      ...opts.gates,
    },
    maxPerRun: 5,
    dueCandidates: async () => opts.candidates ?? [],
    cancelFollowup: async () => { /* no model call */ },
    compose: async (c) => {
      composeCalls.push(c.leadId);
      return { prepared: true, outcome: 'APPROVED_READY' };
    },
  };
  return { deps, composeCalls };
}

describe('paid-LLM guarantee — the model is reached only for a genuinely due follow-up', () => {
  it('makes ZERO model calls when nothing is due (the normal pre-due timer fire)', async () => {
    const h = harness({ candidates: [] });
    const r = await runFollowupPreparation(h.deps);
    expect(r.outcome).toBe('RAN');
    expect(r.considered).toBe(0);
    expect(h.composeCalls).toEqual([]);
  });

  it('makes ZERO model calls when the master gate is off, before even listing candidates', async () => {
    const h = harness({ gates: { followupPreparationEnabled: false }, candidates: [candidate()] });
    const r = await runFollowupPreparation(h.deps);
    expect(r.outcome).toBe('MASTER_DISABLED');
    expect(r.considered).toBe(0);
    expect(h.composeCalls).toEqual([]);
  });

  it('makes ZERO model calls for a suppressed record', async () => {
    for (const status of ['REPLIED_POSITIVE', 'BOUNCED', 'UNSUBSCRIBED', 'MEETING_BOOKED', 'CLOSED_WON'] as const) {
      const h = harness({ candidates: [candidate({ recordStatus: status })] });
      const r = await runFollowupPreparation(h.deps);
      expect(r.blocked).toHaveLength(1);
      expect(h.composeCalls).toEqual([]);
    }
  });

  it('makes ZERO model calls when copy already exists (repeat timer fire)', async () => {
    for (const decision of [null, 'APPROVED', 'REJECTED']) {
      const h = harness({ candidates: [candidate({ existingDraft: { id: 'e1', humanDecision: decision } })] });
      await runFollowupPreparation(h.deps);
      expect(h.composeCalls).toEqual([]);
    }
  });

  it('makes ZERO model calls when the lead is not at the sequence re-entry point', async () => {
    const h = harness({ candidates: [candidate({ leadStatus: 'READY_FOR_HUMAN_APPROVAL' })] });
    await runFollowupPreparation(h.deps);
    expect(h.composeCalls).toEqual([]);
  });

  it('spends ONLY on the eligible candidate when a batch is mixed', async () => {
    const h = harness({
      candidates: [
        candidate({ leadId: 'suppressed', recordStatus: 'REPLIED_NEUTRAL' }),
        candidate({ leadId: 'already', existingDraft: { id: 'e1', humanDecision: null } }),
        candidate({ leadId: 'wrong-state', leadStatus: 'DRAFT_CREATED' }),
        candidate({ leadId: 'eligible' }),
      ],
    });
    await runFollowupPreparation(h.deps);
    expect(h.composeCalls).toEqual(['eligible']);
  });
});

describe('shipped systemd unit — the deployment contract', () => {
  it('runs the inbox-freshness chain BEFORE the follow-up runner, in the right order', () => {
    const pre = DIRECTIVES.filter((l) => l.startsWith('ExecStartPre='));
    const start = DIRECTIVES.filter((l) => l.startsWith('ExecStart='));
    expect(pre).toHaveLength(2);
    expect(start).toHaveLength(1);
    // reply sync first, then delivery reconciliation, then the runner.
    expect(pre[0]).toContain('outreach-sync-replies');
    expect(pre[1]).toContain('outreach-reconcile-delivery');
    expect(start[0]).toContain('run-followup-automation');
    // Both Gmail passes must be the explicitly-confirmed read-only form.
    for (const p of pre) expect(p).toContain('--confirm-gmail-read');
  });

  it('never arms sending authority in version control', () => {
    for (const forbidden of [
      'SENDING_ENABLED=true',
      'OUTBOUND_ACTIONS_ENABLED=true',
      'SCHEDULED_SEND_ENABLED=true',
      'SENDING_PROVIDER=http',
      'DRY_RUN=false',
    ]) {
      expect(DIRECTIVES.some((l) => l.includes(forbidden))).toBe(false);
    }
  });

  it('ships every consequential switch OFF — no spend, no progression', () => {
    expect(DIRECTIVES).toContain('Environment=FOLLOWUP_PREPARATION_ENABLED=false');
    expect(DIRECTIVES).toContain('Environment=FOLLOWUP_PROGRESSION_ENABLED=false');
    // Spending money is a production decision, never a repository default.
    expect(DIRECTIVES).toContain('Environment=ALLOW_PAID_LLM_CALLS=false');
    expect(DIRECTIVES.some((l) => l.includes('ALLOW_PAID_LLM_CALLS=true'))).toBe(false);
  });

  it('keeps the read-only Gmail gate the ExecStartPre guards depend on', () => {
    expect(DIRECTIVES).toContain('Environment=GMAIL_REPLY_SYNC_ENABLED=true');
  });

  it('never reintroduces EnvironmentFile=, which would let .env override the unit gates', () => {
    expect(DIRECTIVES.some((l) => l.startsWith('EnvironmentFile='))).toBe(false);
  });

  it('stays a oneshot unit so a failed ExecStartPre skips ExecStart entirely', () => {
    expect(DIRECTIVES).toContain('Type=oneshot');
  });

  it('allows enough time for the Gmail passes plus a full composition batch', () => {
    const timeout = DIRECTIVES.find((l) => l.startsWith('TimeoutStartSec='));
    const seconds = Number(timeout?.split('=')[1]);
    // Worst case ~1800s (2 model calls x 120s x 5 follow-ups, plus ~300s of read-only Gmail).
    expect(seconds).toBeGreaterThanOrEqual(1800);
  });
});
