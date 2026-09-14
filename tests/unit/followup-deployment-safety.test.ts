import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  runFollowupPreparation,
  type FollowupCandidateView,
  type FollowupPreparationDeps,
} from '../../src/domain/outreach/followup-preparation-runner.js';
import { assertUnattendedPreparationProvider } from '../../src/domain/email/llm-provider-policy.js';

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
/** The PRODUCTION drop-in example: what an operator copies onto the box to arm preparation. */
const LIVE_DROPIN = readFileSync(
  new URL('../../deploy/systemd/automation-suite-followups.service.d/20-preparation-live.conf.example', import.meta.url),
  'utf8',
);
const LIVE_DIRECTIVES = LIVE_DROPIN.split('\n').filter((l) => !l.trimStart().startsWith('#') && l.trim() !== '');
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
  // The pending row is newer than nothing by default; a rejected draft older than it means the
  // operator rescheduled the step and wants fresh copy.
  followupCreatedAtMs: 1_000,
  ...over,
});

function harness(opts: {
  gates?: Partial<FollowupPreparationDeps['gates']>;
  candidates?: FollowupCandidateView[];
  preflight?: FollowupPreparationDeps['preflight'];
} = {}) {
  const composeCalls: string[] = [];
  const listedCandidates: boolean[] = [];
  const deps: FollowupPreparationDeps = {
    now: () => 1_000,
    gates: {
      followupPreparationEnabled: true, outreachTrackingEnabled: true, emailGenerationEnabled: true,
      ...opts.gates,
    },
    preflight: opts.preflight ?? (() => { /* nothing to prove in the paid-call harness */ }),
    maxPerRun: 5,
    dueCandidates: async () => { listedCandidates.push(true); return opts.candidates ?? []; },
    cancelFollowup: async () => { /* no model call */ },
    compose: async (c) => {
      composeCalls.push(c.leadId);
      return { prepared: true, outcome: 'APPROVED_READY' };
    },
  };
  return { deps, composeCalls, listedCandidates };
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
      // createdAt AFTER the pending row: this draft belongs to the row in front of the runner.
      const h = harness({ candidates: [candidate({ existingDraft: { id: 'e1', humanDecision: decision, createdAtMs: 2_000 } })] });
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
        candidate({ leadId: 'already', existingDraft: { id: 'e1', humanDecision: null, createdAtMs: 2_000 } }),
        candidate({ leadId: 'wrong-state', leadStatus: 'DRAFT_CREATED' }),
        candidate({ leadId: 'eligible' }),
      ],
    });
    await runFollowupPreparation(h.deps);
    expect(h.composeCalls).toEqual(['eligible']);
  });
});

describe('preparation preflight — a misconfigured box fails before it can touch the queue', () => {
  it('aborts the whole run: no candidate is listed and nothing is composed', async () => {
    const h = harness({
      candidates: [candidate()],
      preflight: () => { throw new Error('LLM_PROVIDER refused'); },
    });
    await expect(runFollowupPreparation(h.deps)).rejects.toThrow('LLM_PROVIDER refused');
    // Fails BEFORE the worklist query, so no partially-composed batch is possible.
    expect(h.listedCandidates).toEqual([]);
    expect(h.composeCalls).toEqual([]);
  });

  it('runs only after the gates pass, so a disabled install stays a clean no-op', async () => {
    const h = harness({
      gates: { followupPreparationEnabled: false },
      preflight: () => { throw new Error('should not be reached'); },
    });
    const r = await runFollowupPreparation(h.deps);
    expect(r.outcome).toBe('MASTER_DISABLED');
  });
});

describe('live-provider policy — mock copy can never reach the human review queue', () => {
  const live = {
    llmProvider: 'openai', allowPaidLlmCalls: true, openAiApiKey: 'sk-test',
    writerModel: 'gpt-5.6-terra', reviewerModel: 'gpt-5.6-sol', allowMockLlm: false,
  };

  it('refuses the DEFAULT provider, even with paid calls armed', () => {
    // The exact production hazard: ALLOW_PAID_LLM_CALLS=true permits spending but selects nothing,
    // and LLM_PROVIDER defaults to mock.
    expect(() => assertUnattendedPreparationProvider({ ...live, llmProvider: 'mock' }))
      .toThrow(/requires a live model provider/);
  });

  it('refuses any other non-live provider name', () => {
    expect(() => assertUnattendedPreparationProvider({ ...live, llmProvider: '' })).toThrow();
    expect(() => assertUnattendedPreparationProvider({ ...live, llmProvider: 'openai-mock' })).toThrow();
  });

  it('accepts a mock ONLY when an operator deliberately opted in', () => {
    expect(() => assertUnattendedPreparationProvider({ ...live, llmProvider: 'mock', allowMockLlm: true })).not.toThrow();
  });

  it('refuses a live provider whose configuration is incomplete', () => {
    expect(() => assertUnattendedPreparationProvider({ ...live, allowPaidLlmCalls: false })).toThrow(/ALLOW_PAID_LLM_CALLS/);
    expect(() => assertUnattendedPreparationProvider({ ...live, openAiApiKey: undefined })).toThrow(/OPENAI_API_KEY/);
    expect(() => assertUnattendedPreparationProvider({ ...live, writerModel: 'not-a-model' })).toThrow(/No verified price/);
    expect(() => assertUnattendedPreparationProvider({ ...live, reviewerModel: 'not-a-model' })).toThrow(/No verified price/);
  });

  it('accepts a fully configured live provider', () => {
    expect(() => assertUnattendedPreparationProvider(live)).not.toThrow();
  });
});

describe('production drop-in example — what arming preparation must state', () => {
  it('selects the live provider EXPLICITLY rather than relying on the default', () => {
    expect(LIVE_DIRECTIVES).toContain('Environment=LLM_PROVIDER=openai');
    expect(LIVE_DIRECTIVES).toContain('Environment=ALLOW_PAID_LLM_CALLS=true');
  });

  it('never silently accepts mock copy in the human review queue', () => {
    expect(LIVE_DIRECTIVES.some((l) => l.includes('FOLLOWUP_PREPARATION_ALLOW_MOCK_LLM'))).toBe(false);
  });

  it('arms preparation only — progression stays manual for the first controlled follow-up', () => {
    expect(LIVE_DIRECTIVES).toContain('Environment=FOLLOWUP_PREPARATION_ENABLED=true');
    expect(LIVE_DIRECTIVES).toContain('Environment=FOLLOWUP_PROGRESSION_ENABLED=false');
  });

  it('adds no sending authority of any kind', () => {
    for (const forbidden of ['SENDING_ENABLED', 'OUTBOUND_ACTIONS_ENABLED', 'SCHEDULED_SEND_ENABLED', 'SENDING_PROVIDER', 'DRY_RUN']) {
      expect(LIVE_DIRECTIVES.some((l) => l.includes(forbidden))).toBe(false);
    }
  });

  it('leaves the MODELS to validated .env configuration, not to systemd', () => {
    // Authority (provider, spend, phases) lives in the drop-in; model identity is validated config
    // and is already hard-gated by the price table. Pinning it here would split it across two
    // places and let ad-hoc CLI runs diverge from the copy an operator reviews.
    expect(LIVE_DIRECTIVES.some((l) => l.includes('EMAIL_WRITER_MODEL'))).toBe(false);
    expect(LIVE_DIRECTIVES.some((l) => l.includes('EMAIL_REVIEWER_MODEL'))).toBe(false);
  });

  it('is still only an EXAMPLE: committing it deploys nothing', () => {
    expect(LIVE_DROPIN).toContain('NOT INSTALLED');
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

  it('never selects a paid provider in version control, and never pre-accepts mock copy', () => {
    // The base unit stays free and safe: production states the provider in its drop-in.
    expect(DIRECTIVES.some((l) => l.startsWith('Environment=LLM_PROVIDER='))).toBe(false);
    expect(DIRECTIVES.some((l) => l.includes('FOLLOWUP_PREPARATION_ALLOW_MOCK_LLM'))).toBe(false);
  });

  it('still runs exactly one automation command — due promotion added no new entry point', () => {
    const start = DIRECTIVES.filter((l) => l.startsWith('ExecStart='));
    expect(start).toHaveLength(1);
    expect(start[0]).toContain('run-followup-automation');
    // Promotion is a phase of that command, not a second privileged unit.
    expect(DIRECTIVES.some((l) => l.includes('run-scheduled-sends'))).toBe(false);
    expect(DIRECTIVES.some((l) => l.includes('send-scheduled'))).toBe(false);
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
