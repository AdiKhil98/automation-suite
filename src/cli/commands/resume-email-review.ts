import { worstCaseEmailInputTokens } from '../../domain/email/email-token-budget.js';
import {
  ResumeEmailReviewService,
  ResumeReviewAbort,
  type ResumeCommit,
  type ResumeInputs,
} from '../../domain/email/resume-email-review.js';
import { LocalEmailDebugStore } from '../../integrations/email/email-debug-store.js';
import { DrizzleEmailUnitOfWork } from '../../persistence/email-unit-of-work.js';
import { DemoInputRepository } from '../../persistence/repositories/demo-input.repo.js';
import { EmailInputRepository } from '../../persistence/repositories/email-input.repo.js';
import { EmailRepository } from '../../persistence/repositories/email.repo.js';
import { LeadFactsRepository } from '../../persistence/repositories/lead-facts.repo.js';
import { PipelineRunsRepository } from '../../persistence/repositories/runs.repo.js';
import { AppError } from '../../utils/errors.js';
import { buildEmailProvider } from './email-build.js';
import { type CliContext } from '../context.js';

export interface ResumeEmailReviewOptions {
  lead?: string;
  draft?: string;
}

/**
 * Phase-9 recovery: resume ONE persisted REVIEW_FAILED email draft through deterministic
 * validation (current validator) and the adversarial reviewer WITHOUT calling the writer.
 * Requires --lead and --draft; scoped to exactly that draft. No Gmail, no send.
 */
export async function resumeEmailReviewCommand(ctx: CliContext, opts: ResumeEmailReviewOptions): Promise<void> {
  const leadId = opts.lead?.trim();
  const draftId = opts.draft?.trim();
  if (!leadId) throw new AppError('LEAD_REQUIRED', '--lead <id> is required.');
  if (!draftId) throw new AppError('DRAFT_REQUIRED', '--draft <id> is required.');

  const c = ctx.config;
  if (!c.EMAIL_GENERATION_ENABLED) {
    console.log('Email generation is disabled (EMAIL_GENERATION_ENABLED=false).');
    return;
  }

  const provider = buildEmailProvider(ctx); // enforces the same paid-call hard gates
  const providerName = provider.name;

  const emailRepo = new EmailRepository(ctx.db);
  const factsRepo = new LeadFactsRepository(ctx.db);
  const auditRepo = new DemoInputRepository(ctx.db);
  const demoRepo = new EmailInputRepository(ctx.db);
  const uow = new DrizzleEmailUnitOfWork(ctx.db);

  const commit: ResumeCommit = async (plan) => {
    await uow.transaction(async (repos) => {
      const lead = await repos.leads.getById(plan.leadId);
      if (lead && lead.status === 'EMAIL_REVIEW_FAILED') {
        await repos.leadService.transition(plan.leadId, 'EMAIL_DRAFTED');
        if (plan.approved) {
          await repos.leadService.transition(plan.leadId, 'EMAIL_APPROVED');
          if (plan.route !== 'EMAIL_APPROVED') await repos.leadService.transition(plan.leadId, plan.route);
        } else {
          await repos.leadService.transition(plan.leadId, 'EMAIL_REVIEW_FAILED');
        }
      }
      await repos.emails.persist(plan.persist);
      await repos.events.record({
        leadId: plan.leadId, runId: plan.runId, type: 'NOTE', fromStatus: null, toStatus: null,
        message: `resume-email-review: ${plan.approved ? 'APPROVED' : 'REVIEW_REJECTED'} (writer not re-run; source draft ${plan.sourceDraftId})`,
        data: {
          sourceDraftId: plan.sourceDraftId, writerReRun: false, reviewerDecision: plan.reviewerDecision,
          approved: plan.approved, costUsd: plan.costUsd, newDraftId: plan.persist.email?.id ?? null,
        },
      });
    });
  };

  const service = new ResumeEmailReviewService({
    provider,
    debug: new LocalEmailDebugStore(c.EMAIL_DEBUG_DIR),
    ports: {
      loadDraft: (id) => emailRepo.getById(id),
      loadLeadStatus: async (id) => (await ctx.leads.getById(id))?.status ?? null,
      loadInputs: async (id): Promise<ResumeInputs> => {
        const facts = await factsRepo.listCurrentFacts(id);
        const audit = await auditRepo.latestAuditForComposer(id);
        const demo = await demoRepo.latestDemo(id);
        return { facts, findings: audit?.findings ?? [], demo };
      },
    },
    commit,
    logger: ctx.logger,
    config: {
      reviewerModel: c.EMAIL_REVIEWER_MODEL, reviewerEffort: c.EMAIL_REVIEWER_EFFORT, store: c.LLM_STORE_RESPONSES,
      timeoutMs: c.EMAIL_TIMEOUT_MS, maxOutputTokens: c.EMAIL_MAX_OUTPUT_TOKENS, maxRetries: c.EMAIL_MAX_RETRIES,
      maxCostUsdPerLead: c.EMAIL_MAX_COST_USD_PER_LEAD, worstCaseInputTokensPerCall: worstCaseEmailInputTokens(),
    },
  });

  const runs = new PipelineRunsRepository(ctx.db);
  const runId = await runs.start(`resume-email-review:${leadId}`, c.DRY_RUN);

  console.log(`\nResume email review (provider=${providerName}):`);
  console.log(`  lead:  ${leadId}`);
  console.log(`  draft: ${draftId}`);

  try {
    const r = await service.resume({ leadId, draftId }, runId);
    await runs.finish(runId, 'COMPLETED', JSON.stringify(r));

    console.log(`\nOutcome: ${r.outcome}`);
    console.log(`  reviewer calls made:  ${r.callsMade}`);
    console.log(`  actual spend:         $${r.costUsd.toFixed(4)}`);
    if (r.violations.length > 0) console.log(`  validation violations: ${r.violations.join(', ')}`);
    if (r.review) {
      console.log(`  reviewer decision:     ${r.review.decision} (fabricationRisk=${String(r.review.fabricationRisk)})`);
    }
    if (r.newDraftId) console.log(`  new draft id:          ${r.newDraftId}`);
    if (r.newLeadStatus) console.log(`  lead status:           ${r.newLeadStatus}`);
    console.log('\n  No writer call. No Gmail draft. No send. Human review still required.');
  } catch (err) {
    await runs.finish(runId, 'FAILED', err instanceof Error ? err.message : String(err));
    if (err instanceof ResumeReviewAbort) {
      console.error(`\nAborted (${err.code}): ${err.message}`);
      console.error('  No reviewer call was made and nothing was persisted.');
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
