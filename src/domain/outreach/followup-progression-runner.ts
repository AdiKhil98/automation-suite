import { checkFollowupSendAllowed, type FollowupSendBlockReason } from './followup-send-gate.js';
import { type FollowupStep } from './followups.js';
import { isFollowupStep } from './sequence.js';
import { type OutreachStatus } from './status.js';

/**
 * UNATTENDED progression of HUMAN-APPROVED follow-ups through the stages that already exist:
 *
 *     human approval  ->  reply finalization  ->  Gmail draft  ->  send schedule
 *
 * and then it STOPS. Actual sending remains exclusively `run-scheduled-sends -> SendService`; this
 * runner has no provider, no Gmail send call, and no path to one.
 *
 * It duplicates NO business logic: each stage is executed by the same service the manual command
 * uses (`validateReplyFinalization`/`computeReplyFinalization`, `GmailDraftService`,
 * `ScheduleService`), with all their existing validation, fingerprints, idempotency, and fail-closed
 * preconditions intact. This module only decides WHICH stage a lead is due for and in what order.
 *
 * Like `scheduled-send-runner` it is a PURE orchestration over injected effects, so the ordering,
 * gating, suppression, and idempotency rules are unit-testable without a DB or Gmail.
 *
 * SCOPE. It advances FOLLOW-UPS ONLY (`sequenceStep >= 1`). Initial sends keep their existing manual
 * operation exactly as today — this runner can never pick one up.
 */

export type FollowupProgressionOutcome =
  | 'RAN'
  | 'MASTER_DISABLED'
  | 'TRACKING_DISABLED';

/** The next stage a lead is due for, derived purely from its current durable state. */
export type ProgressionStage = 'FINALIZE' | 'CREATE_GMAIL_DRAFT' | 'SCHEDULE';

export interface ProgressionCandidateView {
  leadId: string;
  outreachRecordId: string;
  /** The approved follow-up draft driving this progression. */
  emailDraftId: string;
  sequenceStep: number;
  /** Lead lifecycle position: HUMAN_APPROVED -> DRAFT_CREATED -> SCHEDULED. */
  leadStatus: string;
  /** The draft's human decision; only APPROVED may progress. */
  humanDecision: string | null;
  /** True once a REPLY_DIRECT finalization exists for this draft. */
  hasFinalization: boolean;
  /** True once a Gmail draft exists bound to that finalization. */
  hasGmailDraft: boolean;
  /** True once an ACTIVE (SCHEDULED) send schedule exists for the lead. */
  hasActiveSchedule: boolean;
  /** Authoritative outreach status, re-read now. */
  recordStatus: OutreachStatus | null;
  doNotContact: boolean;
}

export type ProgressionAction =
  | { action: 'ADVANCE'; stage: ProgressionStage; step: FollowupStep }
  | { action: 'DONE'; detail: string }
  | { action: 'SKIP'; reason: ProgressionSkipReason; detail: string }
  | { action: 'BLOCKED'; reason: FollowupSendBlockReason; detail: string };

export type ProgressionSkipReason =
  | 'NOT_A_FOLLOWUP'
  | 'NOT_HUMAN_APPROVED'
  | 'UNEXPECTED_LEAD_STATE';

/**
 * Decide the ONE next stage for a lead. Pure, fail-closed, and ordered so a crash between any two
 * stages simply resumes at the stage that is still missing:
 *
 *   HUMAN_APPROVED + no finalization  -> FINALIZE
 *   HUMAN_APPROVED + finalization     -> CREATE_GMAIL_DRAFT   (the service advances to DRAFT_CREATED)
 *   DRAFT_CREATED                     -> SCHEDULE             (the service advances to SCHEDULED)
 *   SCHEDULED                         -> DONE                 (handed to run-scheduled-sends)
 *
 * Suppression is re-checked here as well as at preparation and immediately before the send, because
 * a reply can land at any moment in between.
 */
export function decideProgression(c: ProgressionCandidateView): ProgressionAction {
  if (!isFollowupStep(c.sequenceStep)) {
    return { action: 'SKIP', reason: 'NOT_A_FOLLOWUP', detail: `sequence step ${String(c.sequenceStep)} is not a follow-up` };
  }
  if (c.humanDecision !== 'APPROVED') {
    // The human gate is absolute: nothing progresses without an explicit approval.
    return { action: 'SKIP', reason: 'NOT_HUMAN_APPROVED', detail: `human decision is ${c.humanDecision ?? 'none'}` };
  }
  const suppression = checkFollowupSendAllowed({
    status: c.recordStatus, doNotContact: c.doNotContact, preparedStep: c.sequenceStep,
  });
  if (!suppression.allowed) {
    return { action: 'BLOCKED', reason: suppression.reason, detail: suppression.detail };
  }
  if (c.leadStatus === 'SCHEDULED' || c.hasActiveSchedule) {
    return { action: 'DONE', detail: 'scheduled; run-scheduled-sends owns it from here' };
  }
  if (c.leadStatus === 'HUMAN_APPROVED') {
    if (!c.hasFinalization) return { action: 'ADVANCE', stage: 'FINALIZE', step: c.sequenceStep };
    if (!c.hasGmailDraft) return { action: 'ADVANCE', stage: 'CREATE_GMAIL_DRAFT', step: c.sequenceStep };
    // A finalization and a Gmail draft exist but the lead never advanced — the Gmail stage is the
    // one that moves it, and it is idempotent, so re-running it is the correct recovery.
    return { action: 'ADVANCE', stage: 'CREATE_GMAIL_DRAFT', step: c.sequenceStep };
  }
  if (c.leadStatus === 'DRAFT_CREATED') {
    return { action: 'ADVANCE', stage: 'SCHEDULE', step: c.sequenceStep };
  }
  return { action: 'SKIP', reason: 'UNEXPECTED_LEAD_STATE', detail: `lead is ${c.leadStatus}` };
}

export interface FollowupProgressionGates {
  /** Master switch for unattended progression. Default OFF. */
  followupProgressionEnabled: boolean;
  outreachTrackingEnabled: boolean;
}

/** Outcome of executing one stage through the existing service. */
export interface StageResult {
  ok: boolean;
  detail: string;
}

export interface FollowupProgressionDeps {
  now(): number;
  gates: FollowupProgressionGates;
  maxPerRun: number;
  /** Approved follow-ups not yet handed to the sender, oldest first, bounded. */
  candidates(nowMs: number, limit: number): Promise<ProgressionCandidateView[]>;
  /** Existing reply-finalization logic (no demo/Netlify; body byte-identical to the approved draft). */
  finalize(c: ProgressionCandidateView): Promise<StageResult>;
  /** Existing GmailDraftService — creates a DRAFT inside the thread. Never sends. */
  createGmailDraft(c: ProgressionCandidateView): Promise<StageResult>;
  /** Existing ScheduleService — records the intended send time. Never sends. */
  schedule(c: ProgressionCandidateView): Promise<StageResult>;
}

export interface ProgressionEntry {
  leadId: string;
  outreachRecordId: string;
  sequenceStep: number;
  stage: ProgressionStage | null;
  action: ProgressionAction['action'];
  detail: string;
}

export interface FollowupProgressionReport {
  outcome: FollowupProgressionOutcome;
  considered: number;
  /** Stages successfully executed this run. */
  advanced: ProgressionEntry[];
  /** Already at the scheduler's door. */
  done: ProgressionEntry[];
  blocked: ProgressionEntry[];
  skipped: ProgressionEntry[];
  /** A stage refused or threw. Surfaced for operator review; never retried blindly in-run. */
  failures: ProgressionEntry[];
}

/**
 * Execute one unattended progression run. Exactly ONE stage is executed per lead per run: each stage
 * advances durable state, so the next run picks the lead up at the next stage. That keeps every run
 * small, ordered, and trivially resumable after a crash — and it means a stage that fails is
 * retried on the next run only because its precondition is still unmet, never because this runner
 * loops on it.
 */
export async function runFollowupProgression(deps: FollowupProgressionDeps): Promise<FollowupProgressionReport> {
  const g = deps.gates;
  const report: FollowupProgressionReport = {
    outcome: 'RAN', considered: 0, advanced: [], done: [], blocked: [], skipped: [], failures: [],
  };
  if (!g.followupProgressionEnabled) { report.outcome = 'MASTER_DISABLED'; return report; }
  if (!g.outreachTrackingEnabled) { report.outcome = 'TRACKING_DISABLED'; return report; }

  const candidates = await deps.candidates(deps.now(), deps.maxPerRun);
  report.considered = candidates.length;

  for (const c of candidates) {
    const entry = (action: ProgressionEntry['action'], stage: ProgressionStage | null, detail: string): ProgressionEntry => ({
      leadId: c.leadId, outreachRecordId: c.outreachRecordId, sequenceStep: c.sequenceStep, stage, action, detail,
    });
    const decision = decideProgression(c);

    if (decision.action === 'BLOCKED') { report.blocked.push(entry('BLOCKED', null, `${decision.reason}: ${decision.detail}`)); continue; }
    if (decision.action === 'SKIP') { report.skipped.push(entry('SKIP', null, `${decision.reason}: ${decision.detail}`)); continue; }
    if (decision.action === 'DONE') { report.done.push(entry('DONE', null, decision.detail)); continue; }

    const run = decision.stage === 'FINALIZE' ? deps.finalize
      : decision.stage === 'CREATE_GMAIL_DRAFT' ? deps.createGmailDraft
        : deps.schedule;
    try {
      const result = await run(c);
      if (result.ok) report.advanced.push(entry('ADVANCE', decision.stage, result.detail));
      else report.failures.push(entry('ADVANCE', decision.stage, result.detail));
    } catch (err) {
      report.failures.push(entry('ADVANCE', decision.stage, `stage threw: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  return report;
}
