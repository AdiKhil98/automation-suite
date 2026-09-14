import { type EmailUnitOfWork } from './email-writer-service.js';
import { type ResumeCommit } from './resume-email-review.js';

/**
 * The ONE way a resumed review reaches the database. Extracted from the CLI so the production path
 * and its integration tests execute the same code — a hand-copied second version is how a test ends
 * up proving something the deployed command does not do.
 *
 * Three writes, chosen by what the attempt actually produced:
 *
 *  - `APPEND` — an unbound draft (no outreach record) gets a NEW row; the original is preserved.
 *  - `RECOVER_IN_PLACE` — a sequence-bound draft IS the canonical draft for its (outreach record,
 *    sequence step) slot (migration 0044 allows exactly one), so the verdict is written onto it.
 *  - `ACCOUNT_FAILED_ATTEMPT` — a PAID call that yielded no usable verdict: the model_call and its
 *    cost are recorded, a bounded diagnostic is appended to the timeline, and NOTHING else moves —
 *    no draft state, no lead transition — so the same draft stays resumable once the cause is fixed.
 */
export function createResumeCommit(uow: EmailUnitOfWork): ResumeCommit {
  return async (plan) => {
    await uow.transaction(async (repos) => {
      // A failed paid attempt is pure accounting: the lead must stay exactly where it is.
      const accountingOnly = plan.write.kind === 'ACCOUNT_FAILED_ATTEMPT';
      const lead = await repos.leads.getById(plan.leadId);
      if (!accountingOnly && lead && lead.status === 'EMAIL_REVIEW_FAILED') {
        await repos.leadService.transition(plan.leadId, 'EMAIL_DRAFTED');
        if (plan.approved) {
          await repos.leadService.transition(plan.leadId, 'EMAIL_APPROVED');
          if (plan.route !== 'EMAIL_APPROVED') await repos.leadService.transition(plan.leadId, plan.route);
        } else {
          await repos.leadService.transition(plan.leadId, 'EMAIL_REVIEW_FAILED');
        }
      }

      if (plan.write.kind === 'APPEND') {
        await repos.emails.persist(plan.write.persist);
      } else if (plan.write.kind === 'RECOVER_IN_PLACE') {
        await repos.emails.applyReviewOutcome(plan.write.draftId, plan.write.update, plan.write.modelCalls);
      } else {
        await repos.emails.recordFailedReviewAttempt(plan.write.draftId, plan.write.addCostUsd, plan.write.modelCalls);
      }

      await repos.events.record({
        leadId: plan.leadId, runId: plan.runId, type: 'NOTE', fromStatus: null, toStatus: null,
        message: accountingOnly
          ? `resume-email-review: ${plan.reviewerDecision} — paid reviewer call produced no usable verdict (draft ${plan.sourceDraftId} unchanged and still resumable)`
          : `resume-email-review: ${plan.approved ? 'APPROVED' : 'REVIEW_REJECTED'} (writer not re-run; source draft ${plan.sourceDraftId})`,
        data: {
          sourceDraftId: plan.sourceDraftId, writerReRun: false, reviewerDecision: plan.reviewerDecision,
          approved: plan.approved, costUsd: plan.costUsd,
          draftWrite: plan.write.kind,
          // The draft that now carries the outcome: a new row, or the canonical row.
          resultDraftId: plan.write.kind === 'APPEND' ? plan.write.persist.email?.id ?? null : plan.write.draftId,
          // Bounded, model-output-only failure diagnostic (schema issues, ids, raw excerpt).
          diagnostic: plan.write.kind === 'ACCOUNT_FAILED_ATTEMPT' ? plan.write.diagnostic : undefined,
        },
      });
    });
  };
}
