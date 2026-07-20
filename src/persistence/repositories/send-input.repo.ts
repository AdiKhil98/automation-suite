import { and, desc, eq } from 'drizzle-orm';
import { type ScheduleView } from '../../domain/send/eligibility.js';
import { type DbExecutor } from '../db.js';
import { emailDraftFinalizations, emailDrafts, gmailDrafts, leadFacts, sendSchedules } from '../schema.js';

export interface SendInputData {
  schedule: ScheduleView | null;
  currentGmailDraft: { id: string; outcome: string; providerDraftId: string | null; gmailAccount: string; senderEmail: string; recipientEmail: string; finalizedEmailId: string | null } | null;
  finalization: { id: string; resolvedBody: string; resolvedBodyHash: string; finalHumanDecision: string | null; finalReviewedAt: Date | null } | null;
  currentFinalizedContentHash: string | null;
  currentRecipientEmail: string | null;
  subject: string | null;
}

/** Read the exact schedule-bound draft, its finalization, and current verified recipient fact. */
export class SendInputRepository {
  constructor(private readonly db: DbExecutor) {}

  async latest(leadId: string): Promise<SendInputData> {
    const sched = (await this.db.select().from(sendSchedules)
      .where(and(eq(sendSchedules.leadId, leadId), eq(sendSchedules.status, 'SCHEDULED')))
      .orderBy(desc(sendSchedules.createdAt)).limit(1))[0];
    const draft = sched
      ? (await this.db.select().from(gmailDrafts)
          .where(and(eq(gmailDrafts.id, sched.gmailDraftId), eq(gmailDrafts.leadId, leadId))).limit(1))[0]
      : undefined;
    const fin = draft?.finalizedEmailId
      ? (await this.db.select({ id: emailDraftFinalizations.id, body: emailDraftFinalizations.resolvedBody,
          h: emailDraftFinalizations.resolvedBodyHash, decision: emailDraftFinalizations.finalHumanDecision,
          reviewedAt: emailDraftFinalizations.finalReviewedAt, subject: emailDrafts.subject })
          .from(emailDraftFinalizations).innerJoin(emailDrafts, eq(emailDrafts.id, emailDraftFinalizations.originalDraftId))
          .where(and(eq(emailDraftFinalizations.id, draft.finalizedEmailId), eq(emailDrafts.leadId, leadId))).limit(1))[0]
      : undefined;
    const recipient = (await this.db.select({ value: leadFacts.value }).from(leadFacts)
      .where(and(eq(leadFacts.leadId, leadId), eq(leadFacts.factType, 'contact_email'), eq(leadFacts.isCurrent, true))).limit(1))[0]?.value ?? null;
    return {
      schedule: sched ? { id: sched.id, status: sched.status, gmailDraftId: sched.gmailDraftId,
        providerDraftId: sched.providerDraftId, finalizedContentHash: sched.finalizedContentHash,
        recipientEmail: sched.recipientEmail, scheduledAtUtcMs: sched.scheduledAtUtc.getTime(),
        rulesVersion: sched.rulesVersion, storedIntegrityFingerprint: sched.integrityFingerprint } : null,
      currentGmailDraft: draft ? { id: draft.id, outcome: draft.outcome, providerDraftId: draft.providerDraftId,
        gmailAccount: draft.gmailAccount, senderEmail: draft.senderEmail, recipientEmail: draft.recipientEmail,
        finalizedEmailId: draft.finalizedEmailId } : null,
      finalization: fin ? { id: fin.id, resolvedBody: fin.body, resolvedBodyHash: fin.h,
        finalHumanDecision: fin.decision, finalReviewedAt: fin.reviewedAt } : null,
      currentFinalizedContentHash: fin?.h ?? null,
      currentRecipientEmail: recipient,
      subject: fin?.subject ?? null,
    };
  }
}
