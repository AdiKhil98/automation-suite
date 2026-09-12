import { and, asc, desc, eq, isNotNull } from 'drizzle-orm';
import { type DbExecutor } from '../db.js';
import { emailDraftFinalizations, emailDrafts, leadFacts, outreachMessages } from '../schema.js';

export interface GmailInputData {
  finalization: { id: string; resolvedBody: string; resolvedBodyHash: string; finalHumanDecision: string | null } | null;
  subject: string;
  /** Verified recipient address from a current contact_email fact, or null (never guessed). */
  recipientEmail: string | null;
  /**
   * The Gmail thread this draft must be created in, or null. Non-null ONLY for a sequence follow-up
   * (`email_drafts.sequence_step > 0`) whose outreach record already has a sent message carrying a
   * thread id. A first email is always null, so its draft creation is unchanged.
   */
  threadId: string | null;
  /** 0 = INITIAL; 1..3 = the internal follow-up step this draft was written for. */
  sequenceStep: number;
}

/** Gathers the approved finalized email, its subject, and a VERIFIED recipient for a lead. */
export class GmailInputRepository {
  constructor(private readonly db: DbExecutor) {}

  async latest(leadId: string): Promise<GmailInputData> {
    const finRow = (await this.db.select({
        f: emailDraftFinalizations,
        subject: emailDrafts.subject,
        sequenceStep: emailDrafts.sequenceStep,
        outreachRecordId: emailDrafts.outreachRecordId,
      })
      .from(emailDraftFinalizations)
      .innerJoin(emailDrafts, eq(emailDrafts.id, emailDraftFinalizations.originalDraftId))
      .where(eq(emailDrafts.leadId, leadId))
      .orderBy(desc(emailDraftFinalizations.finalizedAt)).limit(1))[0];

    const recipientRow = (await this.db.select({ v: leadFacts.value }).from(leadFacts)
      .where(and(eq(leadFacts.leadId, leadId), eq(leadFacts.factType, 'contact_email'), eq(leadFacts.isCurrent, true))).limit(1))[0];

    // Thread continuity, resolved from the record's OWN sent history: the first outbound message
    // that carries a Gmail thread id. Only a follow-up asks for it; without a stored thread the
    // draft is created untethered rather than guessing an id.
    const threadId = finRow && finRow.sequenceStep > 0 && finRow.outreachRecordId !== null
      ? (await this.db.select({ t: outreachMessages.gmailThreadId })
          .from(outreachMessages)
          .where(and(
            eq(outreachMessages.outreachRecordId, finRow.outreachRecordId),
            isNotNull(outreachMessages.gmailThreadId),
          ))
          .orderBy(asc(outreachMessages.sequenceStep), asc(outreachMessages.createdAt))
          .limit(1))[0]?.t ?? null
      : null;

    return {
      finalization: finRow ? { id: finRow.f.id, resolvedBody: finRow.f.resolvedBody, resolvedBodyHash: finRow.f.resolvedBodyHash, finalHumanDecision: finRow.f.finalHumanDecision } : null,
      subject: finRow?.subject ?? '',
      recipientEmail: recipientRow?.v ?? null,
      threadId,
      sequenceStep: finRow?.sequenceStep ?? 0,
    };
  }
}
