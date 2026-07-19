import { and, desc, eq } from 'drizzle-orm';
import { type DbExecutor } from '../db.js';
import { emailDraftFinalizations, emailDrafts, gmailDrafts, leadFacts } from '../schema.js';

export interface ScheduleInputData {
  gmailDraft: { id: string; outcome: string; providerDraftId: string | null } | null;
  finalizedContentHash: string | null;
  recipientEmail: string | null;
  timezone: string | null;
}

/** Gathers the created Gmail draft, the approved finalized content hash, and the verified
 * recipient + IANA timezone facts for a lead (all from persisted state; nothing guessed). */
export class ScheduleInputRepository {
  constructor(private readonly db: DbExecutor) {}

  async latest(leadId: string): Promise<ScheduleInputData> {
    const draft = (await this.db.select().from(gmailDrafts).where(eq(gmailDrafts.leadId, leadId)).orderBy(desc(gmailDrafts.createdAt)).limit(1))[0];
    const fin = (await this.db.select({ h: emailDraftFinalizations.resolvedBodyHash })
      .from(emailDraftFinalizations)
      .innerJoin(emailDrafts, eq(emailDrafts.id, emailDraftFinalizations.originalDraftId))
      .where(eq(emailDrafts.leadId, leadId))
      .orderBy(desc(emailDraftFinalizations.finalizedAt)).limit(1))[0];
    const fact = async (t: string): Promise<string | null> =>
      (await this.db.select({ v: leadFacts.value }).from(leadFacts).where(and(eq(leadFacts.leadId, leadId), eq(leadFacts.factType, t), eq(leadFacts.isCurrent, true))).limit(1))[0]?.v ?? null;

    return {
      gmailDraft: draft ? { id: draft.id, outcome: draft.outcome, providerDraftId: draft.providerDraftId } : null,
      finalizedContentHash: fin?.h ?? null,
      recipientEmail: await fact('contact_email'),
      timezone: await fact('contact_timezone'),
    };
  }
}
