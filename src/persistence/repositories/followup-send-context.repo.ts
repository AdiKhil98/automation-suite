import { and, desc, eq } from 'drizzle-orm';
import { type DbExecutor } from '../db.js';
import { emailDraftFinalizations, emailDrafts, gmailDrafts, outreachRecords, sendSchedules } from '../schema.js';
import { isOutreachStatus, type OutreachStatus } from '../../domain/outreach/status.js';

/**
 * Read-only context for the FINAL pre-send suppression re-check on an automated scheduled send.
 *
 * It answers two questions about the lead's currently ACTIVE schedule, straight from the durable
 * records the send itself is bound to:
 *
 *  1. What sequence position is this pending email? — `email_drafts.sequence_step`, reached through
 *     the schedule's own gmail_draft -> finalization -> email_draft chain. This is durable
 *     provenance, not a guess from the subject, the timestamp, or "the latest email".
 *  2. If it is a follow-up, is the outreach record STILL eligible? — the record's current status and
 *     do-not-contact flag, re-read now rather than trusted from when the copy was prepared days ago.
 *
 * SELECT-only; it performs no write and makes no external call.
 */
export interface PendingSendContext {
  /** 0 = INITIAL / lesson Outreach #1; 1..3 = the internal follow-up step. */
  sequenceStep: number;
  emailDraftId: string;
  /** The outreach record the draft was written for, when it recorded one. */
  outreachRecordId: string | null;
  /** Current outreach status, or null when no record could be resolved. */
  outreachStatus: OutreachStatus | null;
  outreachDoNotContact: boolean;
}

export class FollowupSendContextRepository {
  constructor(private readonly db: DbExecutor) {}

  /** Context for the lead's active SCHEDULED send, or null when there is none. */
  async forLead(leadId: string): Promise<PendingSendContext | null> {
    const rows = await this.db
      .select({
        sequenceStep: emailDrafts.sequenceStep,
        emailDraftId: emailDrafts.id,
        outreachRecordId: emailDrafts.outreachRecordId,
        scheduledAt: sendSchedules.scheduledAtUtc,
      })
      .from(sendSchedules)
      .innerJoin(gmailDrafts, eq(gmailDrafts.id, sendSchedules.gmailDraftId))
      .innerJoin(emailDraftFinalizations, eq(emailDraftFinalizations.id, gmailDrafts.finalizedEmailId))
      .innerJoin(emailDrafts, eq(emailDrafts.id, emailDraftFinalizations.originalDraftId))
      .where(and(eq(sendSchedules.leadId, leadId), eq(sendSchedules.status, 'SCHEDULED')))
      .orderBy(desc(sendSchedules.createdAt))
      .limit(1);
    const r = rows[0];
    if (!r) return null;

    if (r.outreachRecordId === null) {
      return {
        sequenceStep: r.sequenceStep, emailDraftId: r.emailDraftId, outreachRecordId: null,
        outreachStatus: null, outreachDoNotContact: false,
      };
    }
    const rec = (await this.db
      .select({ status: outreachRecords.status, doNotContact: outreachRecords.doNotContact })
      .from(outreachRecords)
      .where(eq(outreachRecords.id, r.outreachRecordId))
      .limit(1))[0];
    return {
      sequenceStep: r.sequenceStep,
      emailDraftId: r.emailDraftId,
      outreachRecordId: r.outreachRecordId,
      // An unrecognised stored status is treated as "no usable record", which fails the gate closed.
      outreachStatus: rec && isOutreachStatus(rec.status) ? rec.status : null,
      outreachDoNotContact: rec?.doNotContact ?? false,
    };
  }
}
