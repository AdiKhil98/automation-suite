import { isAuthorizationValid } from '../../domain/send/scheduled-send-authorization.js';
import {
  runScheduledSends,
  type EnrollmentOutcome,
  type ScheduledRunDeps,
  type SendOneResult,
} from '../../domain/send/scheduled-send-runner.js';
import { type SendService } from '../../domain/send/send-service.js';
import { PipelineRunsRepository } from '../../persistence/repositories/runs.repo.js';
import { SendInputRepository } from '../../persistence/repositories/send-input.repo.js';
import { SendRepository } from '../../persistence/repositories/send.repo.js';
import { ScheduledSendAuthorizationRepository } from '../../persistence/repositories/scheduled-send.repo.js';
import { buildScheduledSendService, buildSendProvider } from './send-build.js';
import { enrollConfirmedSendFromAttempt } from './outreach-enroll-sent.js';
import { type CliContext } from '../context.js';

/**
 * AUTOMATED scheduled-send runner (non-interactive). It reuses the existing Phase 14/15 `SendService`
 * (no second send path) and the confirmed-send bridge, gated by the master switch, the global send
 * gates, outreach tracking, and a VALID durable authorization. It sends at most the daily capacity,
 * auto-enrolls each confirmed send, and STOPS on the first OUTCOME_UNKNOWN (never retried).
 */
export async function runScheduledSendsCommand(ctx: CliContext): Promise<void> {
  const c = ctx.config;
  const gmailAccount = c.GMAIL_ACCOUNT_EMAIL?.trim().toLowerCase() ?? '';
  const policyVersion = c.SENDING_POLICY_VERSION;
  const authRepo = new ScheduledSendAuthorizationRepository(ctx.db);
  const sendRepo = new SendRepository(ctx.db);
  const inputRepo = new SendInputRepository(ctx.db);

  // Lazily-built provider/service/runId so a no-op run (gates off) touches no credentials or DB writes.
  let service: SendService | null = null;
  let runId: string | null = null;
  const getService = (): SendService => (service ??= buildScheduledSendService(ctx, buildSendProvider(ctx)));
  const getRunId = async (): Promise<string> => (runId ??= await new PipelineRunsRepository(ctx.db).start('send:scheduled-auto', c.DRY_RUN));

  const sendOne = async (leadId: string, authorizationId: string): Promise<SendOneResult> => {
    const lead = await ctx.leads.getById(leadId);
    const data = lead ? await inputRepo.latest(leadId) : null;
    if (!lead || !data?.schedule) return { outcome: 'INVALID_ELIGIBILITY', attemptId: null, reason: 'no_active_schedule' };
    const baseInput = {
      leadId, leadStatus: lead.status, schedule: data.schedule, currentGmailDraft: data.currentGmailDraft,
      finalization: data.finalization, currentFinalizedContentHash: data.currentFinalizedContentHash,
      currentRecipientEmail: data.currentRecipientEmail, subject: data.subject, normalizedDomain: data.normalizedDomain,
      normalizedPhone: data.normalizedPhone, placeId: data.placeId, confirmation: null, preflightProof: null,
    };
    const svc = getService();
    const preflight = await svc.preflight(baseInput);
    if (preflight.outcome !== 'READY' || !preflight.preflightProof) {
      return { outcome: preflight.outcome, attemptId: null, reason: preflight.reason };
    }
    // The interactive TTY confirmation is replaced by a deterministic attestation tied to the durable
    // authorization; integrity is preserved because preflight re-verified the live draft envelope.
    const confirmation = {
      observedSendFingerprint: preflight.preflightProof.sendFingerprint,
      confirmedBy: `scheduler:${authorizationId}`,
      confirmedAtMs: Date.now(),
    };
    const result = await svc.send({ ...baseInput, preflightProof: preflight.preflightProof, confirmation }, await getRunId());
    const attemptId = result.outcome === 'SENT_CONFIRMED'
      ? await authRepo.latestConfirmedAttemptId(leadId)
      : result.outcome === 'OUTCOME_UNKNOWN'
        ? await authRepo.latestUnknownAttemptId(leadId)
        : null;
    return { outcome: result.outcome, attemptId, reason: result.reason };
  };

  const enroll = async (leadId: string, attemptId: string): Promise<EnrollmentOutcome> => {
    const r = await enrollConfirmedSendFromAttempt(ctx, { lead: leadId, fromAttempt: attemptId, by: 'scheduler' });
    return r.outcome === 'REFUSED' ? 'ENROLL_FAILED' : r.outcome;
  };

  const deps: ScheduledRunDeps = {
    now: () => Date.now(),
    gates: {
      scheduledSendEnabled: c.SCHEDULED_SEND_ENABLED,
      sendingEnabled: c.SENDING_ENABLED,
      outboundActionsEnabled: c.OUTBOUND_ACTIONS_ENABLED,
      dryRun: c.DRY_RUN,
      providerIsHttp: c.SENDING_PROVIDER === 'http',
      outreachTrackingEnabled: c.OUTREACH_TRACKING_ENABLED,
    },
    sendingDailyCap: c.SENDING_DAILY_CAP,
    findUnenrolledConfirmedSends: () => authRepo.unenrolledConfirmedSends(50),
    getValidAuthorization: async (nowMs) => {
      const auth = await authRepo.getActive(gmailAccount, policyVersion);
      return auth && isAuthorizationValid(auth, nowMs, gmailAccount, policyVersion) ? { id: auth.id, maxPerDay: auth.maxPerDay } : null;
    },
    confirmedSendsToday: (nowMs) => sendRepo.confirmedSendsToday(gmailAccount, new Date(nowMs)),
    mintSessionReadiness: async (authorizationId, nowMs) => {
      await authRepo.mintSessionReadiness({
        gmailAccount, policyVersion, authorizationId,
        approvedAt: new Date(nowMs),
        expiresAt: new Date(nowMs + c.SCHEDULED_SEND_SESSION_READINESS_MINUTES * 60_000),
      });
    },
    dueScheduledLeadIds: (nowMs, limit) => authRepo.dueScheduledLeadIds(nowMs, limit),
    sendOne,
    enroll,
  };

  const report = await runScheduledSends(deps);
  if (runId) await new PipelineRunsRepository(ctx.db).finish(runId, 'COMPLETED', report.outcome);

  console.log(`\nScheduled send run: ${report.outcome} (capacity=${String(report.capacity)}, attempted=${String(report.attempted)})`);
  for (const rec of report.recovered) console.log(`  RECOVERED ${rec.leadId} attempt=${rec.attemptId} enroll=${rec.outcome} (no send performed)`);
  for (const rf of report.recoveryFailures) console.log(`  RECOVERY_FAILED ${rf.leadId} attempt=${rf.attemptId} enroll=${rf.outcome} — re-run enrolls it; NEVER resends`);
  for (const s of report.sent) console.log(`  SENT ${s.leadId} attempt=${s.attemptId} enroll=${s.enrollment}`);
  for (const u of report.unknown) console.log(`  OUTCOME_UNKNOWN ${u.leadId} attempt=${u.attemptId ?? '-'} — STOPPED, do NOT retry; reconcile manually`);
  for (const f of report.failures) console.log(`  NOT_SENT ${f.leadId} outcome=${f.outcome}${f.reason ? ` (${f.reason})` : ''}`);
  console.log(`SUMMARY_JSON ${JSON.stringify(report)}`);

  const problems = report.unknown.length > 0
    || report.failures.length > 0
    || report.recoveryFailures.length > 0
    || report.sent.some((s) => s.enrollment === 'ENROLL_FAILED' || s.enrollment === 'RECORD_NOT_ENROLLABLE');
  if (problems) process.exitCode = 1;
}
