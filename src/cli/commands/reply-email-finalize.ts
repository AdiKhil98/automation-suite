import { randomUUID } from 'node:crypto';
import {
  computeReplyFinalization,
  validateReplyFinalization,
} from '../../domain/email/reply-finalization.js';
import { PipelineRepository } from '../../persistence/repositories/pipeline.repo.js';
import { ReplyFinalizationRepository } from '../../persistence/repositories/reply-finalization.repo.js';
import { AppError } from '../../utils/errors.js';
import { type CliContext } from '../context.js';

export interface ReplyEmailFinalizeOptions {
  lead?: string;
  draft?: string;
  by?: string;
  confirm?: boolean;
}

/**
 * Create the REPLY_DIRECT `email_draft_finalizations` record for an already-approved reply email, so it
 * carries the finalization the Gmail eligibility gate requires — WITHOUT a demo/Netlify/{{DEMO_URL}}. The
 * finalized body is byte-identical to the approved draft body (no substitution). Idempotent, deterministic.
 *
 * Fail-closed preconditions: lead HUMAN_APPROVED; draft belongs to lead; draft status APPROVED; human
 * decision APPROVED; ctaKind reply; body has no {{DEMO_URL}} and no unresolved token except {{SENDER_NAME}}.
 * Zero LLM/network/Gmail/send/Sheets. Enables no flags. Does not transition the lead (it stays HUMAN_APPROVED).
 */
export async function replyEmailFinalizeCommand(ctx: CliContext, opts: ReplyEmailFinalizeOptions): Promise<void> {
  const leadId = opts.lead?.trim();
  const draftId = opts.draft?.trim();
  const operator = opts.by?.trim();
  if (!leadId) throw new AppError('LEAD_REQUIRED', '--lead <id> is required.');
  if (!draftId) throw new AppError('DRAFT_REQUIRED', '--draft <email_draft_id> is required.');
  if (!operator) throw new AppError('OPERATOR_REQUIRED', '--by <operator> is required.');

  const lead = await ctx.leads.getById(leadId);
  if (!lead) throw new AppError('LEAD_NOT_FOUND', `Lead ${leadId} not found.`);

  const repo = new ReplyFinalizationRepository(ctx.db);
  const draft = await repo.getDraft(draftId);

  const check = validateReplyFinalization({ requestedLeadId: leadId, leadStatus: lead.status, draft });
  if (!check.ok) {
    console.error(`Reply finalization REFUSED (fail-closed). Violations:\n  - ${check.violations.join('\n  - ')}`);
    console.error('\nNo finalization written. No side effects.');
    process.exitCode = 1;
    return;
  }
  // draft is non-null here (validation would have failed otherwise).
  const body = draft?.body ?? '';
  const subject = draft?.subject ?? '';

  if (await repo.hasReplyFinalization(draftId)) {
    console.log(`Reply finalization already exists for draft ${draftId}. Idempotent no-op — nothing written.`);
    return;
  }

  const { resolvedBody, originalBodyHash, resolvedBodyHash } = computeReplyFinalization(body);
  const finalizationId = randomUUID();

  console.log(`\n=== Reply finalization (lead ${leadId}) ===`);
  console.log(`  finalization id:   ${finalizationId}`);
  console.log(`  email draft:       ${draftId}`);
  console.log(`  kind:              REPLY_DIRECT`);
  console.log(`  final decision:    APPROVED`);
  console.log(`  final reviewed by: ${operator}`);
  console.log(`  original body hash:${originalBodyHash}`);
  console.log(`  resolved body hash:${resolvedBodyHash}`);
  console.log(`  hashes equal:      ${String(originalBodyHash === resolvedBodyHash)}`);
  console.log(`\n  Subject: ${subject}`);
  console.log(`\n${resolvedBody.split('\n').map((l) => `  | ${l}`).join('\n')}`);

  if (!opts.confirm) {
    console.log('\n  Dry preview only. Re-run with --confirm to persist the finalization.');
    console.log('  No finalization written. No state change. No Gmail/send.');
    return;
  }

  await ctx.db.transaction(async (tx) => {
    const now = new Date();
    await new ReplyFinalizationRepository(tx).insertReplyFinalization({
      id: finalizationId, originalDraftId: draftId, resolvedBody, originalBodyHash, resolvedBodyHash,
      finalReviewedBy: operator, finalReviewedAt: now,
    });
    await new PipelineRepository(tx).record({
      leadId, runId: null, type: 'NOTE', fromStatus: null, toStatus: null,
      message: `reply email finalized (by ${operator})`,
      data: { kind: 'REPLY_DIRECT', finalizationId, emailDraftId: draftId, resolvedBodyHash, finalHumanDecision: 'APPROVED', operator },
    });
  });

  console.log(`\n  Persisted reply finalization ${finalizationId} (kind REPLY_DIRECT, finalHumanDecision APPROVED).`);
  console.log('  Lead stays HUMAN_APPROVED. No Gmail draft, no send, no flags changed.');
}
