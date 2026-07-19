import { and, desc, eq } from 'drizzle-orm';
import { type DbExecutor } from '../db.js';
import { emailDraftFinalizations, emailDrafts, leadFacts } from '../schema.js';

export interface GmailInputData {
  finalization: { id: string; resolvedBody: string; resolvedBodyHash: string; finalHumanDecision: string | null } | null;
  subject: string;
  /** Verified recipient address from a current contact_email fact, or null (never guessed). */
  recipientEmail: string | null;
}

/** Gathers the approved finalized email, its subject, and a VERIFIED recipient for a lead. */
export class GmailInputRepository {
  constructor(private readonly db: DbExecutor) {}

  async latest(leadId: string): Promise<GmailInputData> {
    const finRow = (await this.db.select({ f: emailDraftFinalizations, subject: emailDrafts.subject })
      .from(emailDraftFinalizations)
      .innerJoin(emailDrafts, eq(emailDrafts.id, emailDraftFinalizations.originalDraftId))
      .where(eq(emailDrafts.leadId, leadId))
      .orderBy(desc(emailDraftFinalizations.finalizedAt)).limit(1))[0];

    const recipientRow = (await this.db.select({ v: leadFacts.value }).from(leadFacts)
      .where(and(eq(leadFacts.leadId, leadId), eq(leadFacts.factType, 'contact_email'), eq(leadFacts.isCurrent, true))).limit(1))[0];

    return {
      finalization: finRow ? { id: finRow.f.id, resolvedBody: finRow.f.resolvedBody, resolvedBodyHash: finRow.f.resolvedBodyHash, finalHumanDecision: finRow.f.finalHumanDecision } : null,
      subject: finRow?.subject ?? '',
      recipientEmail: recipientRow?.v ?? null,
    };
  }
}
