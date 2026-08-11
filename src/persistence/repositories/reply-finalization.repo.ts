import { and, eq } from 'drizzle-orm';
import { REPLY_FINALIZATION_KIND, type ReplyFinalizationDraft } from '../../domain/email/reply-finalization.js';
import { type DbExecutor } from '../db.js';
import { emailDraftFinalizations, emailDrafts } from '../schema.js';

export interface ReplyFinalizationInsert {
  id: string;
  originalDraftId: string;
  resolvedBody: string;
  originalBodyHash: string;
  resolvedBodyHash: string;
  finalReviewedBy: string;
  finalReviewedAt: Date;
}

/**
 * Persistence for REPLY_DIRECT finalizations. It writes ONLY into the existing `email_draft_finalizations`
 * table (a second producer for it) and NEVER into the demo deploy repo. Demo finalizations are untouched.
 */
export class ReplyFinalizationRepository {
  constructor(private readonly db: DbExecutor) {}

  /** The draft to finalize (subject/body/status/humanDecision/ctaKind), or null. */
  async getDraft(draftId: string): Promise<(ReplyFinalizationDraft & { subject: string }) | null> {
    const r = (await this.db
      .select({ id: emailDrafts.id, leadId: emailDrafts.leadId, status: emailDrafts.status, humanDecision: emailDrafts.humanDecision, ctaKind: emailDrafts.ctaKind, subject: emailDrafts.subject, body: emailDrafts.body })
      .from(emailDrafts).where(eq(emailDrafts.id, draftId)).limit(1))[0];
    return r ? { id: r.id, leadId: r.leadId, status: r.status, humanDecision: r.humanDecision, ctaKind: r.ctaKind, subject: r.subject, body: r.body } : null;
  }

  /** True if a REPLY_DIRECT finalization already exists for the draft (idempotency guard). */
  async hasReplyFinalization(originalDraftId: string): Promise<boolean> {
    const r = await this.db.select({ id: emailDraftFinalizations.id }).from(emailDraftFinalizations)
      .where(and(eq(emailDraftFinalizations.originalDraftId, originalDraftId), eq(emailDraftFinalizations.kind, REPLY_FINALIZATION_KIND))).limit(1);
    return r.length > 0;
  }

  /** Insert a REPLY_DIRECT finalization (no deployment, no verified URL) with the final human approval. */
  async insertReplyFinalization(row: ReplyFinalizationInsert): Promise<void> {
    await this.db.insert(emailDraftFinalizations).values({
      id: row.id,
      originalDraftId: row.originalDraftId,
      deploymentRunId: null,
      verifiedDeploymentUrl: null,
      kind: REPLY_FINALIZATION_KIND,
      originalBodyHash: row.originalBodyHash,
      resolvedBody: row.resolvedBody,
      resolvedBodyHash: row.resolvedBodyHash,
      finalHumanDecision: 'APPROVED',
      finalReviewedBy: row.finalReviewedBy,
      finalReviewedAt: row.finalReviewedAt,
      finalReviewedSource: 'cli',
    });
  }
}
