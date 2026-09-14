import { checkFollowupSendAllowed, type FollowupSendBlockReason } from './followup-send-gate.js';
import { type FollowupStep } from './followups.js';
import { isFollowupStep } from './sequence.js';
import { type OutreachStatus } from './status.js';

/**
 * UNATTENDED preparation of DUE follow-ups. Same architectural style as `scheduled-send-runner`: a
 * PURE orchestration over injected effects, so every gate, skip, cancellation, and idempotency rule
 * is unit-testable with no DB, no model provider, and no Gmail.
 *
 * It NEVER sends and NEVER bypasses human approval. All it does is decide which due follow-ups may
 * be composed, hand each to the EXISTING `EmailWriterService` (writer -> deterministic validation ->
 * independent adversarial reviewer -> gate), and leave the approved copy in the EXISTING human
 * review queue. A human still decides whether anything goes out.
 *
 * Safe to run on a timer: it is idempotent per (outreach record, sequence step), so repeated runs
 * never produce a second draft for the same follow-up.
 */

export type FollowupPreparationOutcome =
  | 'RAN'
  | 'MASTER_DISABLED'
  | 'TRACKING_DISABLED'
  | 'EMAIL_GENERATION_DISABLED';

/** What a single due follow-up looks like to the decision function. */
export interface FollowupCandidateView {
  followupId: string;
  outreachRecordId: string;
  leadId: string;
  step: number;
  /** Authoritative outreach status, re-read now (null when the record could not be resolved). */
  recordStatus: OutreachStatus | null;
  doNotContact: boolean;
  /** Current lead lifecycle status — must be SENT, the sequence re-entry point. */
  leadStatus: string;
  /**
   * The draft already composed for this exact (record, step), if any. Its presence is what makes a
   * repeated timer run a no-op; its human decision is what distinguishes "still awaiting review"
   * from "the operator rejected this copy".
   */
  existingDraft: { id: string; humanDecision: string | null } | null;
}

export type FollowupPrepareAction =
  /** Compose it: hand this step to the email writer + reviewer. */
  | { action: 'COMPOSE'; step: FollowupStep }
  /**
   * The operator rejected this copy. The follow-up row is cancelled so the sequence stops cleanly
   * instead of leaving a DUE row that would be re-examined on every future run forever.
   */
  | { action: 'CANCEL_REJECTED'; reason: string }
  /** Nothing to do; the run leaves the record exactly as it found it. */
  | { action: 'SKIP'; reason: FollowupPrepareSkipReason; detail: string }
  /** Suppressed by authoritative outreach state (reply/bounce/DNC/meeting/closed/step mismatch). */
  | { action: 'BLOCKED'; reason: FollowupSendBlockReason; detail: string };

export type FollowupPrepareSkipReason =
  | 'UNKNOWN_STEP'
  | 'ALREADY_PREPARED'
  | 'AWAITING_HUMAN_REVIEW'
  | 'LEAD_NOT_AT_SEQUENCE_REENTRY';

/**
 * Decide what to do with ONE due follow-up. Pure and fail-closed: every branch that is not an
 * unambiguous "compose this" leaves the record untouched.
 *
 * Order matters. Suppression is evaluated BEFORE the idempotency shortcuts so a prospect who replied
 * is reported as blocked rather than silently skipped, and the unknown-step guard runs first so a
 * malformed row can never reach the writer.
 */
export function decideFollowupPreparation(c: FollowupCandidateView): FollowupPrepareAction {
  if (!isFollowupStep(c.step)) {
    return { action: 'SKIP', reason: 'UNKNOWN_STEP', detail: `step ${String(c.step)} is not a follow-up step` };
  }
  const suppression = checkFollowupSendAllowed({
    status: c.recordStatus, doNotContact: c.doNotContact, preparedStep: c.step,
  });
  if (!suppression.allowed) {
    return { action: 'BLOCKED', reason: suppression.reason, detail: suppression.detail };
  }
  if (c.existingDraft) {
    if (c.existingDraft.humanDecision === 'REJECTED') {
      return {
        action: 'CANCEL_REJECTED',
        reason: `follow-up copy ${c.existingDraft.id} was rejected in human review`,
      };
    }
    if (c.existingDraft.humanDecision === 'APPROVED') {
      // Approved copy is the progression runner's job, not this one's.
      return { action: 'SKIP', reason: 'ALREADY_PREPARED', detail: `draft ${c.existingDraft.id} is approved and progressing` };
    }
    return { action: 'SKIP', reason: 'AWAITING_HUMAN_REVIEW', detail: `draft ${c.existingDraft.id} is waiting for a human decision` };
  }
  if (c.leadStatus !== 'SENT') {
    // SENT is the only legal sequence re-entry point. Anything else means the lead is mid-pipeline,
    // parked for manual review, or terminal — a human decides, not this runner.
    return { action: 'SKIP', reason: 'LEAD_NOT_AT_SEQUENCE_REENTRY', detail: `lead is ${c.leadStatus}, not SENT` };
  }
  return { action: 'COMPOSE', step: c.step };
}

/** Why a composition attempt did not yield approved copy (the writer's own outcome). */
export interface ComposeResult {
  prepared: boolean;
  outcome: string;
}

export interface FollowupPreparationGates {
  /** Master switch for unattended preparation. Default OFF. */
  followupPreparationEnabled: boolean;
  /** Outreach tracking must be on: without it there is no authoritative sequence state. */
  outreachTrackingEnabled: boolean;
  /** The writer/reviewer must be enabled to compose anything. */
  emailGenerationEnabled: boolean;
}

export interface FollowupPreparationDeps {
  now(): number;
  gates: FollowupPreparationGates;
  /**
   * Fail-closed preflight, run AFTER the gates pass and BEFORE any candidate is listed or composed.
   * It exists so a misconfigured box (most importantly: armed for production but still on the MOCK
   * model provider) aborts the whole run loudly, instead of quietly persisting fixture copy into
   * the human review queue one candidate at a time. Throwing here writes nothing.
   */
  preflight(): Promise<void> | void;
  /** Hard bound on model spend per run. */
  maxPerRun: number;
  /** Due follow-ups, oldest first, already bounded by `maxPerRun`. */
  dueCandidates(nowMs: number, limit: number): Promise<FollowupCandidateView[]>;
  /** Cancel a pending follow-up row (existing OutreachService operation; never sends). */
  cancelFollowup(followupId: string, outreachRecordId: string, reason: string): Promise<void>;
  /** Compose one follow-up via the EXISTING EmailWriterService. Never sends, never auto-approves. */
  compose(candidate: FollowupCandidateView & { step: FollowupStep }): Promise<ComposeResult>;
}

export interface FollowupPreparationEntry {
  followupId: string;
  outreachRecordId: string;
  leadId: string;
  step: number;
  action: FollowupPrepareAction['action'];
  detail: string;
}

export interface FollowupPreparationReport {
  outcome: FollowupPreparationOutcome;
  considered: number;
  /** Composed and AI-reviewed; now awaiting a HUMAN decision. */
  prepared: FollowupPreparationEntry[];
  /** Suppressed by authoritative outreach state. */
  blocked: FollowupPreparationEntry[];
  /** Deliberately untouched (already prepared, awaiting review, lead not at re-entry, bad step). */
  skipped: FollowupPreparationEntry[];
  /** Pending rows cancelled because the operator rejected the copy. */
  cancelled: FollowupPreparationEntry[];
  /** Composition ran but produced no approved copy, or threw. Surfaced for operator review. */
  failures: FollowupPreparationEntry[];
}

/**
 * Execute one unattended preparation run.
 *
 * Fail-closed at every gate, and at the preflight that follows them. Composition is bounded by `maxPerRun` (model spend). A candidate that
 * throws is recorded as a failure and the run continues — one bad lead never stalls the queue, and
 * nothing about a failure can cause a send.
 */
export async function runFollowupPreparation(deps: FollowupPreparationDeps): Promise<FollowupPreparationReport> {
  const g = deps.gates;
  const report: FollowupPreparationReport = {
    outcome: 'RAN', considered: 0, prepared: [], blocked: [], skipped: [], cancelled: [], failures: [],
  };
  if (!g.followupPreparationEnabled) { report.outcome = 'MASTER_DISABLED'; return report; }
  if (!g.outreachTrackingEnabled) { report.outcome = 'TRACKING_DISABLED'; return report; }
  if (!g.emailGenerationEnabled) { report.outcome = 'EMAIL_GENERATION_DISABLED'; return report; }
  // Deliberately propagates: a preflight failure must abort the run (and fail the systemd unit),
  // never degrade into a partially-composed batch.
  await deps.preflight();

  const candidates = await deps.dueCandidates(deps.now(), deps.maxPerRun);
  report.considered = candidates.length;

  for (const c of candidates) {
    const entry = (action: FollowupPreparationEntry['action'], detail: string): FollowupPreparationEntry => ({
      followupId: c.followupId, outreachRecordId: c.outreachRecordId, leadId: c.leadId, step: c.step, action, detail,
    });
    const decision = decideFollowupPreparation(c);

    if (decision.action === 'BLOCKED') { report.blocked.push(entry('BLOCKED', `${decision.reason}: ${decision.detail}`)); continue; }
    if (decision.action === 'SKIP') { report.skipped.push(entry('SKIP', `${decision.reason}: ${decision.detail}`)); continue; }

    if (decision.action === 'CANCEL_REJECTED') {
      try {
        await deps.cancelFollowup(c.followupId, c.outreachRecordId, 'HUMAN_REJECTED_COPY');
        report.cancelled.push(entry('CANCEL_REJECTED', decision.reason));
      } catch (err) {
        report.failures.push(entry('CANCEL_REJECTED', `cancel failed: ${err instanceof Error ? err.message : String(err)}`));
      }
      continue;
    }

    try {
      const result = await deps.compose({ ...c, step: decision.step });
      if (result.prepared) report.prepared.push(entry('COMPOSE', result.outcome));
      else report.failures.push(entry('COMPOSE', `no approved copy: ${result.outcome}`));
    } catch (err) {
      report.failures.push(entry('COMPOSE', `compose threw: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  return report;
}
