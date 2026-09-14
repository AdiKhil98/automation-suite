import { followupBlockedReason, type FollowupBlockedReason, type FollowupStep } from './followups.js';
import { type FollowupStatus } from './records.js';
import { followupDueStatus, isFollowupStep, statusBeforeFollowupDue } from './sequence.js';
import { type OutreachStatus } from './status.js';

/**
 * DUE-STATE PROMOTION — the missing first phase of unattended follow-up automation.
 *
 * `scheduleFollowup` writes a follow-up ROW with an explicit due instant, but it deliberately does
 * NOT move the record's status: at scheduling time the follow-up is merely planned, and a record
 * that has only sent its initial email is still `INITIAL_SENT`. The status that says "this record
 * is waiting to send follow-up N *right now*" (`FOLLOW_UP_N_DUE`) was, until this module, only ever
 * reachable through the manual `outreach transition` CLI. Preparation re-checks suppression via
 * `checkFollowupSendAllowed`, which requires exactly that status, so an unattended run could never
 * compose anything: every genuinely due follow-up was reported `BLOCKED / NOT_AWAITING_FOLLOWUP`
 * and an operator had to hand-transition every record — which defeats the unattended design.
 *
 * This phase closes that gap WITHOUT weakening any gate. It is a pure decision over durable state:
 *
 *   an ACTIVE (`DUE`) follow-up row whose due instant has passed
 *   + a record sitting in EXACTLY the status that step must follow (`statusBeforeFollowupDue`)
 *   + no suppression (reply / bounce / unsubscribe / DNC / meeting / closed / do-not-contact)
 *   ------------------------------------------------------------------------------------------
 *   -> promote the record to `followupDueStatus(step)` and nothing else.
 *
 * What promotion is NOT allowed to do, by construction:
 *  - it never derives due-ness from elapsed time, message history, or "the latest email" — only an
 *    actual `DUE` row with an actual `dueAt` can drive it;
 *  - it never invents or reschedules a follow-up row, and never touches `dueAt` or `nextFollowupAt`;
 *  - it never skips a step: the expected FROM status is derived from the step itself, so a record
 *    that is not exactly one legal hop away is left untouched;
 *  - it grants NO new authority: both the source and destination statuses are non-sending, and
 *    composing, drafting, scheduling, and sending all remain behind their own separate gates.
 *
 * Promotion is only ever the FIRST of three ordered phases, and human approval is still mandatory
 * between phase two (preparation) and phase three (progression).
 */

export type FollowupPromotionOutcome = 'RAN' | 'MASTER_DISABLED' | 'TRACKING_DISABLED';

/** What ONE due follow-up row + its record look like to the decision function. */
export interface FollowupPromotionCandidateView {
  followupId: string;
  outreachRecordId: string;
  leadId: string;
  step: number;
  /** The follow-up ROW's own status. Only an active `DUE` row may drive a promotion. */
  followupStatus: FollowupStatus;
  /** The row's explicit due instant. Promotion never guesses this from message history. */
  dueAtMs: number;
  /** Authoritative record status, re-read now (null when the record could not be resolved). */
  recordStatus: OutreachStatus | null;
  doNotContact: boolean;
}

export type FollowupPromotionAction =
  /** Move the record one legal hop: `from` (what this step must follow) -> `to` (this step is due). */
  | { action: 'PROMOTE'; step: FollowupStep; from: OutreachStatus; to: OutreachStatus }
  /** The record already announces this step as due. Idempotent no-op: nothing is written. */
  | { action: 'ALREADY_DUE'; detail: string }
  /** Nothing to do; the record is left exactly as it was found. */
  | { action: 'SKIP'; reason: FollowupPromotionSkipReason; detail: string }
  /** Suppressed by authoritative outreach state — the sequence must stop, not advance. */
  | { action: 'BLOCKED'; reason: FollowupPromotionBlockReason; detail: string };

export type FollowupPromotionSkipReason =
  /** The row's step is not a real follow-up step (malformed data). */
  | 'UNKNOWN_STEP'
  /** The row is CANCELLED, POSTPONED, or already SENT — only a `DUE` row may promote. */
  | 'FOLLOWUP_NOT_ACTIVE'
  /** The due instant has not passed yet. */
  | 'NOT_YET_DUE'
  /** No outreach record could be resolved for the row. */
  | 'NO_OUTREACH_RECORD'
  /** The record is not in the exact status this step must follow (wrong step, or mid-sequence). */
  | 'STATUS_MISMATCH';

export type FollowupPromotionBlockReason = Exclude<FollowupBlockedReason, null> | 'DO_NOT_CONTACT';

/**
 * Decide what to do with ONE due follow-up row. Pure and fail-closed: every branch that is not an
 * unambiguous "this record is exactly one legal hop from announcing this step as due" leaves the
 * record untouched.
 *
 * Order matters:
 *  1. malformed rows are rejected before anything else can reason about them;
 *  2. row liveness and due-ness come next, so a cancelled or not-yet-due row can never promote;
 *  3. suppression is evaluated BEFORE the idempotency shortcut, so a prospect who replied is
 *     reported as blocked rather than silently treated as "already due";
 *  4. the expected-FROM check is last, and is derived from the step — never assumed.
 */
export function decideFollowupPromotion(
  c: FollowupPromotionCandidateView,
  nowMs: number,
): FollowupPromotionAction {
  if (!isFollowupStep(c.step)) {
    return { action: 'SKIP', reason: 'UNKNOWN_STEP', detail: `step ${String(c.step)} is not a follow-up step` };
  }
  if (c.followupStatus !== 'DUE') {
    return {
      action: 'SKIP',
      reason: 'FOLLOWUP_NOT_ACTIVE',
      detail: `follow-up row is ${c.followupStatus}, not DUE`,
    };
  }
  if (c.dueAtMs > nowMs) {
    return {
      action: 'SKIP',
      reason: 'NOT_YET_DUE',
      detail: `due at ${new Date(c.dueAtMs).toISOString()}, now ${new Date(nowMs).toISOString()}`,
    };
  }
  if (c.recordStatus === null) {
    return { action: 'SKIP', reason: 'NO_OUTREACH_RECORD', detail: 'no outreach record for this follow-up' };
  }
  if (c.doNotContact) {
    return { action: 'BLOCKED', reason: 'DO_NOT_CONTACT', detail: 'contact is marked do-not-contact' };
  }
  const blocked = followupBlockedReason(c.recordStatus);
  if (blocked !== null) {
    return { action: 'BLOCKED', reason: blocked, detail: `outreach record is ${c.recordStatus}` };
  }

  const to = followupDueStatus(c.step);
  if (c.recordStatus === to) {
    // A previous run already promoted this record. Repeating the run must write nothing at all.
    return { action: 'ALREADY_DUE', detail: `outreach record is already ${to}` };
  }
  const from = statusBeforeFollowupDue(c.step);
  if (c.recordStatus !== from) {
    return {
      action: 'SKIP',
      reason: 'STATUS_MISMATCH',
      detail: `step ${String(c.step)} requires the record to be ${from}, but it is ${c.recordStatus}`,
    };
  }
  return { action: 'PROMOTE', step: c.step, from, to };
}

/** The durable result of attempting ONE promotion (the service re-decides inside its transaction). */
export interface PromoteResult {
  promoted: boolean;
  outcome: string;
}

export interface FollowupPromotionGates {
  /**
   * Master switch. Promotion is the first phase OF preparation and is pointless without it, so it
   * shares `FOLLOWUP_PREPARATION_ENABLED` rather than adding a switch that could drift out of sync.
   */
  followupPromotionEnabled: boolean;
  /** Outreach tracking must be on: without it there is no authoritative sequence state. */
  outreachTrackingEnabled: boolean;
}

export interface FollowupPromotionDeps {
  now(): number;
  gates: FollowupPromotionGates;
  /** Bound on how many records one run may promote (kept aligned with preparation's bound). */
  maxPerRun: number;
  /** Due, active follow-up rows, oldest first, already bounded by `maxPerRun`. */
  candidates(nowMs: number, limit: number): Promise<FollowupPromotionCandidateView[]>;
  /**
   * Apply ONE promotion atomically. The implementation MUST re-read state and re-decide inside its
   * own transaction — the snapshot listed above is stale by the time this is called.
   */
  promote(candidate: FollowupPromotionCandidateView & { step: FollowupStep }): Promise<PromoteResult>;
}

export interface FollowupPromotionEntry {
  followupId: string;
  outreachRecordId: string;
  leadId: string;
  step: number;
  action: FollowupPromotionAction['action'] | 'NO_CHANGE' | 'PROMOTE_FAILED';
  detail: string;
}

export interface FollowupPromotionReport {
  outcome: FollowupPromotionOutcome;
  considered: number;
  /** Records moved to `FOLLOW_UP_N_DUE`; preparation can now compose them. */
  promoted: FollowupPromotionEntry[];
  /**
   * Nothing was written: the record was already at the due status, or the authoritative re-decision
   * inside the transaction declined (a reply landed, or a concurrent run won the race). Normal
   * operation under a repeating timer — never an error.
   */
  unchanged: FollowupPromotionEntry[];
  /** Suppressed by authoritative outreach state. */
  blocked: FollowupPromotionEntry[];
  /** Deliberately untouched (not yet due, inactive row, bad step, status mismatch). */
  skipped: FollowupPromotionEntry[];
  /** The write threw. Surfaced for operator review; never advances anything. */
  failures: FollowupPromotionEntry[];
}

/**
 * Execute one unattended promotion run. Fail-closed at every gate, bounded by `maxPerRun`, and
 * free: promotion makes no model call, no Gmail call, and no external request of any kind.
 *
 * A candidate that throws is recorded as a failure and the run continues — one bad row never stalls
 * the queue, and nothing about a failure can promote a different record.
 */
export async function runFollowupDuePromotion(
  deps: FollowupPromotionDeps,
): Promise<FollowupPromotionReport> {
  const g = deps.gates;
  const report: FollowupPromotionReport = {
    outcome: 'RAN', considered: 0, promoted: [], unchanged: [], blocked: [], skipped: [], failures: [],
  };
  if (!g.followupPromotionEnabled) { report.outcome = 'MASTER_DISABLED'; return report; }
  if (!g.outreachTrackingEnabled) { report.outcome = 'TRACKING_DISABLED'; return report; }

  const candidates = await deps.candidates(deps.now(), deps.maxPerRun);
  report.considered = candidates.length;

  for (const c of candidates) {
    const entry = (
      action: FollowupPromotionEntry['action'],
      detail: string,
    ): FollowupPromotionEntry => ({
      followupId: c.followupId, outreachRecordId: c.outreachRecordId, leadId: c.leadId, step: c.step,
      action, detail,
    });
    const decision = decideFollowupPromotion(c, deps.now());

    if (decision.action === 'BLOCKED') { report.blocked.push(entry('BLOCKED', `${decision.reason}: ${decision.detail}`)); continue; }
    if (decision.action === 'SKIP') { report.skipped.push(entry('SKIP', `${decision.reason}: ${decision.detail}`)); continue; }
    if (decision.action === 'ALREADY_DUE') { report.unchanged.push(entry('ALREADY_DUE', decision.detail)); continue; }

    try {
      const result = await deps.promote({ ...c, step: decision.step });
      if (result.promoted) report.promoted.push(entry('PROMOTE', result.outcome));
      // The authoritative re-decision inside the transaction disagreed with this stale snapshot
      // (a reply landed, or a concurrent run won the race). That is correct fail-closed behaviour,
      // not an error: report it without advancing anything.
      else report.unchanged.push(entry('NO_CHANGE', result.outcome));
    } catch (err) {
      report.failures.push(entry('PROMOTE_FAILED', `promote threw: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  return report;
}
