import { randomUUID } from 'node:crypto';
import {
  runFollowupPreparation,
  type ComposeResult,
  type FollowupCandidateView,
  type FollowupPreparationDeps,
  type FollowupPreparationReport,
} from '../../domain/outreach/followup-preparation-runner.js';
import {
  runFollowupProgression,
  type FollowupProgressionDeps,
  type FollowupProgressionReport,
  type ProgressionCandidateView,
  type StageResult,
} from '../../domain/outreach/followup-progression-runner.js';
import { OutreachService } from '../../domain/outreach/outreach-service.js';
import { lessonEmailLabel } from '../../domain/outreach/sequence.js';
import { computeReplyFinalization, validateReplyFinalization } from '../../domain/email/reply-finalization.js';
import { DrizzleOutreachUnitOfWork } from '../../persistence/outreach-unit-of-work.js';
import { ContactResolutionRepository } from '../../persistence/repositories/contact-resolution.repo.js';
import { DemoInputRepository } from '../../persistence/repositories/demo-input.repo.js';
import { FollowupPreparationRepository } from '../../persistence/repositories/followup-preparation.repo.js';
import { GmailInputRepository } from '../../persistence/repositories/gmail-input.repo.js';
import { LeadFactsRepository } from '../../persistence/repositories/lead-facts.repo.js';
import { PipelineRepository } from '../../persistence/repositories/pipeline.repo.js';
import { PipelineRunsRepository } from '../../persistence/repositories/runs.repo.js';
import { ReplyFinalizationRepository } from '../../persistence/repositories/reply-finalization.repo.js';
import { ScheduleInputRepository } from '../../persistence/repositories/schedule-input.repo.js';
import { buildEmailService } from './email-build.js';
import { buildGmailService } from './gmail-build.js';
import { buildScheduleService } from './schedule-build.js';
import { type CliContext } from '../context.js';

export interface RunFollowupAutomationOptions {
  phase?: string;
  limit?: string;
  record?: string;
  lead?: string;
  dryRun?: boolean;
}

/**
 * UNATTENDED follow-up automation — the timer entry point. It automates everything AROUND human
 * review and nothing of human review itself, in two independently-gated phases:
 *
 *   Phase A (preparation): compose DUE follow-ups through the EXISTING writer -> deterministic
 *     validation -> independent adversarial reviewer -> gate, with the step-specific job and rubric,
 *     and park the approved copy in the EXISTING human review queue. Stops there.
 *
 *   Phase B (progression): take follow-ups a HUMAN has approved and advance them one stage through
 *     the EXISTING services — reply finalization -> Gmail draft -> send schedule — then stop.
 *
 * NEITHER phase sends. Dispatch remains exclusively `run-scheduled-sends` -> `SendService`, behind
 * its own separate gates, durable authorization, preflight, and daily cap. This command has no send
 * provider and no path to one.
 *
 * Both phases are idempotent and safe to run on a repeating timer: preparation is keyed on
 * (outreach record, sequence step) and backed by migration 0044's partial unique index; progression
 * executes exactly one stage per lead per run, and every stage is gated on durable state that the
 * stage itself advances.
 */
export async function runFollowupAutomationCommand(ctx: CliContext, cliOpts: RunFollowupAutomationOptions): Promise<void> {
  const c = ctx.config;
  const phase = (cliOpts.phase ?? 'both').toLowerCase();
  const wantPrepare = phase === 'both' || phase === 'prepare';
  const wantProgress = phase === 'both' || phase === 'progress';
  if (!wantPrepare && !wantProgress) {
    console.log(`Unknown --phase "${cliOpts.phase ?? ''}". Use prepare, progress, or both.`);
    process.exitCode = 1;
    return;
  }
  const dryRun = cliOpts.dryRun === true;

  const prepRepo = new FollowupPreparationRepository(ctx.db);
  const runs = new PipelineRunsRepository(ctx.db);
  let runId: string | null = null;
  const getRunId = async (): Promise<string> => (runId ??= await runs.start('outreach:followup-automation', c.DRY_RUN));

  let prepReport: FollowupPreparationReport | null = null;
  let progReport: FollowupProgressionReport | null = null;

  // ---------------- Phase A: preparation ----------------
  if (wantPrepare) {
    const factsRepo = new LeadFactsRepository(ctx.db);
    const auditRepo = new DemoInputRepository(ctx.db);
    const resolutionRepo = new ContactResolutionRepository(ctx.db);
    const outreach = new OutreachService(new DrizzleOutreachUnitOfWork(ctx.db));
    // Built lazily so a disabled/no-work run touches no model credentials.
    let emailService: ReturnType<typeof buildEmailService> | null = null;
    const getEmailService = () => (emailService ??= buildEmailService(ctx));

    const compose = async (cand: FollowupCandidateView & { step: 1 | 2 | 3 }): Promise<ComposeResult> => {
      const facts = await factsRepo.listCurrentFacts(cand.leadId);
      const audit = await auditRepo.latestAuditForComposer(cand.leadId);
      if (!audit) return { prepared: false, outcome: 'NO_AUDIT_EVIDENCE' };
      const thread = await prepRepo.threadContext(cand.outreachRecordId);
      const resolution = await resolutionRepo.getCurrent(cand.leadId);
      const recipient = resolution
        ? {
            contactType: resolution.resolutionType,
            email: resolution.recipientEmail,
            intendedDecisionMakers: resolution.intendedDecisionMakers.map((d) => ({ fullName: d.fullName, title: d.title })),
          }
        : null;
      if (dryRun) {
        return { prepared: true, outcome: `DRY_RUN (thread subject ${thread.threadSubject === null ? '(none)' : JSON.stringify(thread.threadSubject)}, ${String(thread.priorMessages.length)} prior message(s)) — nothing written` };
      }
      // A follow-up never carries a demo link: the concept was already offered in the thread and the
      // step jobs forbid adding new material. `demo: null` makes VIEW_CONCEPT impossible by construction.
      const { service } = getEmailService();
      const result = await service.write({
        leadId: cand.leadId,
        facts,
        findings: audit.findings,
        demo: null,
        opportunityScore: audit.opportunityScore,
        recipient,
        sequence: { step: cand.step, threadSubject: thread.threadSubject, priorMessages: thread.priorMessages },
        outreachRecordId: cand.outreachRecordId,
      }, await getRunId());
      return { prepared: result.outcome === 'APPROVED_READY', outcome: result.outcome };
    };

    const deps: FollowupPreparationDeps = {
      now: () => Date.now(),
      gates: {
        followupPreparationEnabled: c.FOLLOWUP_PREPARATION_ENABLED,
        outreachTrackingEnabled: c.OUTREACH_TRACKING_ENABLED,
        emailGenerationEnabled: c.EMAIL_GENERATION_ENABLED,
      },
      maxPerRun: cliOpts.limit ? Number.parseInt(cliOpts.limit, 10) : c.FOLLOWUP_PREPARATION_MAX_PER_RUN,
      dueCandidates: (nowMs, limit) => prepRepo.dueCandidates(nowMs, limit, { recordId: cliOpts.record }),
      cancelFollowup: async (followupId, recordId, reason) => {
        if (dryRun) return;
        await outreach.cancelFollowup(followupId, recordId, reason);
      },
      compose,
    };
    prepReport = await runFollowupPreparation(deps);
  }

  // ---------------- Phase B: progression ----------------
  if (wantProgress) {
    const gmailInputRepo = new GmailInputRepository(ctx.db);
    const scheduleInputRepo = new ScheduleInputRepository(ctx.db);
    let gmail: ReturnType<typeof buildGmailService> | null = null;
    const getGmail = () => (gmail ??= buildGmailService(ctx));
    let scheduler: ReturnType<typeof buildScheduleService> | null = null;
    const getScheduler = () => (scheduler ??= buildScheduleService(ctx));

    /**
     * Reply finalization via the EXACT existing domain logic (`validateReplyFinalization` +
     * `computeReplyFinalization` + `ReplyFinalizationRepository`) — the same functions the manual
     * `reply-email-finalize` command calls, with the same fail-closed preconditions. No business
     * rule is re-expressed here.
     */
    const finalize = async (cand: ProgressionCandidateView): Promise<StageResult> => {
      const repo = new ReplyFinalizationRepository(ctx.db);
      const draft = await repo.getDraft(cand.emailDraftId);
      const check = validateReplyFinalization({
        requestedLeadId: cand.leadId, leadStatus: cand.leadStatus, draft,
      });
      if (!check.ok) return { ok: false, detail: `finalization refused: ${check.violations.join(',')}` };
      if (await repo.hasReplyFinalization(cand.emailDraftId)) {
        return { ok: true, detail: 'finalization already existed (idempotent no-op)' };
      }
      if (dryRun) return { ok: true, detail: 'DRY_RUN: would finalize' };

      const { resolvedBody, originalBodyHash, resolvedBodyHash } = computeReplyFinalization(draft?.body ?? '');
      const finalizationId = randomUUID();
      await ctx.db.transaction(async (tx) => {
        const now = new Date();
        await new ReplyFinalizationRepository(tx).insertReplyFinalization({
          id: finalizationId, originalDraftId: cand.emailDraftId, resolvedBody,
          originalBodyHash, resolvedBodyHash,
          finalReviewedBy: c.FOLLOWUP_AUTOMATION_ACTOR, finalReviewedAt: now,
        });
        await new PipelineRepository(tx).record({
          leadId: cand.leadId, runId: null, type: 'NOTE', fromStatus: null, toStatus: null,
          message: `follow-up email finalized automatically (${c.FOLLOWUP_AUTOMATION_ACTOR})`,
          data: {
            kind: 'REPLY_DIRECT', finalizationId, emailDraftId: cand.emailDraftId, resolvedBodyHash,
            finalHumanDecision: 'APPROVED', sequenceStep: cand.sequenceStep,
            derivedFromHumanApprovalOf: cand.emailDraftId,
            note: 'automated finalization of copy a human already approved; the human approval is recorded separately on the draft',
          },
        });
      });
      return { ok: true, detail: `finalized ${finalizationId}` };
    };

    /** Gmail DRAFT creation via the existing GmailDraftService (threaded; never sends). */
    const createGmailDraft = async (cand: ProgressionCandidateView): Promise<StageResult> => {
      if (!c.GMAIL_DRAFTS_ENABLED || !c.GMAIL_DRAFT_ACTIONS_ENABLED) {
        return { ok: false, detail: 'gmail draft creation disabled (GMAIL_DRAFTS_ENABLED / GMAIL_DRAFT_ACTIONS_ENABLED)' };
      }
      const data = await gmailInputRepo.latest(cand.leadId);
      if (dryRun) return { ok: true, detail: `DRY_RUN: would create a Gmail draft in thread ${data.threadId ?? '(none)'}` };
      const { service } = getGmail();
      const r = await service.createDraft({
        leadId: cand.leadId, leadStatus: cand.leadStatus, finalization: data.finalization,
        subject: data.subject, recipientEmail: data.recipientEmail, threadId: data.threadId,
      }, await getRunId());
      const ok = r.outcome === 'DRAFT_CREATED' || r.outcome === 'DUPLICATE_REUSED';
      return { ok, detail: `gmail draft: ${r.outcome}` };
    };

    /** Send-time scheduling via the existing ScheduleService (records an intent; never sends). */
    const schedule = async (cand: ProgressionCandidateView): Promise<StageResult> => {
      if (!c.SCHEDULING_ENABLED && !dryRun) return { ok: false, detail: 'scheduling disabled (SCHEDULING_ENABLED=false)' };
      const data = await scheduleInputRepo.latest(cand.leadId);
      const r = await getScheduler().schedule({
        leadId: cand.leadId, leadStatus: cand.leadStatus, gmailDraft: data.gmailDraft,
        finalizedContentHash: data.finalizedContentHash, recipientEmail: data.recipientEmail,
        timezone: data.timezone,
      }, dryRun ? '' : await getRunId(), { dryRun });
      const ok = r.outcome === 'SCHEDULED' || r.outcome === 'SCHEDULED_DRYRUN' || r.outcome === 'DUPLICATE_REUSED';
      return { ok, detail: `schedule: ${r.outcome}${r.scheduledAtUtc ? ` → ${r.scheduledAtUtc}` : ''}${r.reason ? ` (${r.reason})` : ''}` };
    };

    const deps: FollowupProgressionDeps = {
      now: () => Date.now(),
      gates: {
        followupProgressionEnabled: c.FOLLOWUP_PROGRESSION_ENABLED,
        outreachTrackingEnabled: c.OUTREACH_TRACKING_ENABLED,
      },
      maxPerRun: cliOpts.limit ? Number.parseInt(cliOpts.limit, 10) : c.FOLLOWUP_PROGRESSION_MAX_PER_RUN,
      candidates: (_nowMs, limit) => prepRepo.progressionCandidates(limit, { leadId: cliOpts.lead }),
      finalize,
      createGmailDraft,
      schedule,
    };
    progReport = await runFollowupProgression(deps);
  }

  if (runId) {
    await runs.finish(runId, 'COMPLETED', JSON.stringify({ prepare: prepReport?.outcome, progress: progReport?.outcome }));
  }

  // ---------------- Operator output ----------------
  console.log(`\nFollow-up automation run (dry-run=${String(dryRun)}):`);
  if (prepReport) {
    console.log(`\n  PREPARATION: ${prepReport.outcome} (considered=${String(prepReport.considered)})`);
    for (const e of prepReport.prepared) console.log(`    PREPARED    ${label(e.leadId, e.step)} — ${e.detail}; awaiting HUMAN approval`);
    for (const e of prepReport.cancelled) console.log(`    CANCELLED   ${label(e.leadId, e.step)} — ${e.detail}`);
    for (const e of prepReport.blocked) console.log(`    BLOCKED     ${label(e.leadId, e.step)} — ${e.detail}`);
    for (const e of prepReport.skipped) console.log(`    SKIP        ${label(e.leadId, e.step)} — ${e.detail}`);
    for (const e of prepReport.failures) console.log(`    FAILED      ${label(e.leadId, e.step)} — ${e.detail}`);
  }
  if (progReport) {
    console.log(`\n  PROGRESSION: ${progReport.outcome} (considered=${String(progReport.considered)})`);
    for (const e of progReport.advanced) console.log(`    ADVANCED    ${label(e.leadId, e.sequenceStep)} [${e.stage ?? '-'}] — ${e.detail}`);
    for (const e of progReport.done) console.log(`    READY       ${label(e.leadId, e.sequenceStep)} — ${e.detail}`);
    for (const e of progReport.blocked) console.log(`    BLOCKED     ${label(e.leadId, e.sequenceStep)} — ${e.detail}`);
    for (const e of progReport.skipped) console.log(`    SKIP        ${label(e.leadId, e.sequenceStep)} — ${e.detail}`);
    for (const e of progReport.failures) console.log(`    FAILED      ${label(e.leadId, e.sequenceStep)} [${e.stage ?? '-'}] — ${e.detail}`);
  }
  console.log(`\nSUMMARY_JSON ${JSON.stringify({ prepare: prepReport, progress: progReport })}`);
  console.log('\n  Nothing was sent. Sending happens ONLY in run-scheduled-sends -> SendService.');

  // Non-zero exit surfaces problems to the scheduler's error handler. A BLOCKED follow-up is normal
  // operation (the prospect replied), so it is deliberately NOT a failure.
  const problems = (prepReport?.failures.length ?? 0) > 0 || (progReport?.failures.length ?? 0) > 0;
  if (problems) process.exitCode = 1;
}

function label(leadId: string, step: number): string {
  const name = step >= 0 && step <= 3 ? lessonEmailLabel(step as 0 | 1 | 2 | 3) : `step ${String(step)}`;
  return `${leadId} ${name}`;
}
