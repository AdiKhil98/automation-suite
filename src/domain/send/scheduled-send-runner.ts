import { type SendOutcome } from './send-service.js';

/**
 * Non-interactive scheduled-send orchestrator (Automation Suite = execution/source of truth; the
 * external scheduler only triggers it). It is a PURE orchestration over injected effects, so the
 * recovery/gate/cap/loop/OUTCOME_UNKNOWN logic is fully unit-testable without a DB or provider.
 *
 * It NEVER introduces a second send path: `sendOne` wraps the existing Phase 14/15 `SendService`
 * (preflight + eligibility + reservation + send) and `enroll` wraps the existing idempotent
 * confirmed-send bridge. This module only decides WHETHER and HOW MANY to attempt, plus a
 * self-healing enrollment sweep that never sends.
 */

export type ScheduledRunOutcome =
  | 'RAN'
  | 'MASTER_DISABLED'
  | 'GATES_DISABLED'
  | 'TRACKING_DISABLED'
  | 'NO_AUTHORIZATION'
  | 'CAP_REACHED';

export type EnrollmentOutcome = 'ENROLLED' | 'ALREADY_ENROLLED' | 'RECORD_NOT_ENROLLABLE' | 'ENROLL_FAILED';

export interface SendOneResult {
  outcome: SendOutcome;
  /** The confirmed/unknown send_attempt id (present for SENT_CONFIRMED and OUTCOME_UNKNOWN). */
  attemptId: string | null;
  reason?: string;
}

export interface ScheduledRunGates {
  scheduledSendEnabled: boolean;
  sendingEnabled: boolean;
  outboundActionsEnabled: boolean;
  dryRun: boolean;
  providerIsHttp: boolean;
  outreachTrackingEnabled: boolean;
}

export interface ScheduledRunDeps {
  now(): number;
  gates: ScheduledRunGates;
  sendingDailyCap: number;
  /**
   * Confirmed (SENT_CONFIRMED / reconciled CONFIRMED_SENT) production attempts that do NOT yet have a
   * matching outreach message by Gmail message id — i.e. sends whose enrollment failed or was never
   * run (including a crashed prior runner). NEVER returns OUTCOME_UNKNOWN / DEFINITIVE_FAILURE attempts.
   */
  findUnenrolledConfirmedSends(): Promise<Array<{ leadId: string; attemptId: string }>>;
  /** The single valid durable authorization, or null (fail-closed). */
  getValidAuthorization(nowMs: number): Promise<{ id: string; maxPerDay: number } | null>;
  /** Confirmed sends already recorded for the account today (cap accounting). */
  confirmedSendsToday(nowMs: number): Promise<number>;
  /** Mint the short-lived SCHEDULED session readiness derived from the authorization. */
  mintSessionReadiness(authorizationId: string, nowMs: number): Promise<void>;
  /** Lead ids whose active schedule is due now, capped to `limit` (deterministic order). */
  dueScheduledLeadIds(nowMs: number, limit: number): Promise<string[]>;
  /** Attempt exactly one lead via the existing SendService (preflight + send). Never retries. */
  sendOne(leadId: string, authorizationId: string): Promise<SendOneResult>;
  /** Enroll a confirmed send into outreach tracking (idempotent bridge; never sends). */
  enroll(leadId: string, attemptId: string): Promise<EnrollmentOutcome>;
}

export interface RecoveryEntry {
  leadId: string;
  attemptId: string;
  outcome: EnrollmentOutcome;
}

export interface ScheduledRunReport {
  outcome: ScheduledRunOutcome;
  authorizationId: string | null;
  capacity: number;
  attempted: number;
  /** Confirmed-but-unenrolled sends healed this run (ENROLLED / ALREADY_ENROLLED). */
  recovered: RecoveryEntry[];
  /** Recovery attempts that did NOT enroll (surfaced for alerting; never a resend). */
  recoveryFailures: RecoveryEntry[];
  sent: Array<{ leadId: string; attemptId: string; enrollment: EnrollmentOutcome }>;
  unknown: Array<{ leadId: string; attemptId: string | null }>;
  failures: Array<{ leadId: string; outcome: SendOutcome; reason?: string }>;
}

/**
 * Execute one scheduled run.
 *
 * Phase 0 (self-healing, NEVER sends): whenever outreach tracking is enabled — independent of the
 * send gates, so a crashed/failed prior run is healed even while sending is paused — enroll every
 * confirmed send that has no matching outreach message yet, via the idempotent bridge. The
 * migration-0037 unique index is the hard duplicate backstop; a recovery failure is surfaced but
 * never causes a resend.
 *
 * Phase 1 (sending, fail-closed at every gate): sends at most `capacity` (= the lesser of the account
 * daily cap and the authorization cap, minus what already went out today). On the FIRST
 * `OUTCOME_UNKNOWN` it stops the run and never retries. `DEFINITIVE_FAILURE`/skips are recorded and
 * do not stop the run. A confirmed send whose enrollment fails in the loop is healed by Phase 0 of
 * the NEXT run.
 */
export async function runScheduledSends(deps: ScheduledRunDeps): Promise<ScheduledRunReport> {
  const g = deps.gates;
  const now = deps.now();
  const report: ScheduledRunReport = {
    outcome: 'RAN', authorizationId: null, capacity: 0, attempted: 0,
    recovered: [], recoveryFailures: [], sent: [], unknown: [], failures: [],
  };

  // --- Phase 0: self-healing enrollment recovery (never sends) ---
  // Requires tracking to enroll; runs before the send gates so it heals prior runs even when the
  // automation is otherwise paused. Enrollment is idempotent (ALREADY_ENROLLED + the 0037 index).
  if (g.outreachTrackingEnabled) {
    const pending = await deps.findUnenrolledConfirmedSends();
    for (const p of pending) {
      let outcome: EnrollmentOutcome;
      try {
        outcome = await deps.enroll(p.leadId, p.attemptId);
      } catch {
        outcome = 'ENROLL_FAILED';
      }
      const entry: RecoveryEntry = { leadId: p.leadId, attemptId: p.attemptId, outcome };
      if (outcome === 'ENROLLED' || outcome === 'ALREADY_ENROLLED') report.recovered.push(entry);
      else report.recoveryFailures.push(entry);
    }
  }

  // --- Phase 1: send gates (fail-closed). Recovery results are preserved in every early return. ---
  if (!g.scheduledSendEnabled) { report.outcome = 'MASTER_DISABLED'; return report; }
  if (!g.sendingEnabled || !g.outboundActionsEnabled || g.dryRun || !g.providerIsHttp) { report.outcome = 'GATES_DISABLED'; return report; }
  // Enrollment is mandatory after a confirmed send, so refuse to send if tracking is off.
  if (!g.outreachTrackingEnabled) { report.outcome = 'TRACKING_DISABLED'; return report; }

  const auth = await deps.getValidAuthorization(now);
  if (!auth) { report.outcome = 'NO_AUTHORIZATION'; return report; }
  report.authorizationId = auth.id;

  const sentToday = await deps.confirmedSendsToday(now);
  const capacity = Math.max(0, Math.min(deps.sendingDailyCap, auth.maxPerDay) - sentToday);
  report.capacity = capacity;
  if (capacity <= 0) { report.outcome = 'CAP_REACHED'; return report; }

  // Only now (a valid authorization + real capacity) do we mint the session readiness.
  await deps.mintSessionReadiness(auth.id, now);

  const leadIds = await deps.dueScheduledLeadIds(now, capacity);
  for (const leadId of leadIds) {
    if (report.sent.length >= capacity) break;
    report.attempted += 1;
    const r = await deps.sendOne(leadId, auth.id);

    if (r.outcome === 'SENT_CONFIRMED' && r.attemptId) {
      let enrollment: EnrollmentOutcome;
      try {
        enrollment = await deps.enroll(leadId, r.attemptId);
      } catch {
        enrollment = 'ENROLL_FAILED';
      }
      report.sent.push({ leadId, attemptId: r.attemptId, enrollment });
      continue;
    }

    if (r.outcome === 'OUTCOME_UNKNOWN') {
      // Never auto-retried. Stop the run so a human reconciles before any further automated send.
      report.unknown.push({ leadId, attemptId: r.attemptId });
      break;
    }

    report.failures.push({ leadId, outcome: r.outcome, reason: r.reason });
  }

  return report;
}
