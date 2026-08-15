import { eq } from 'drizzle-orm';
import { type DbExecutor } from '../db.js';
import { emailDraftFinalizations, emailDrafts, gmailDrafts, sendAttempts } from '../schema.js';

/**
 * Read-only assembly of a CONFIRMED production send's enrollment inputs for the
 * production-send -> outreach bridge (`outreach-enroll-sent`). Everything is drawn from the
 * existing send/email pipeline records so nothing is ever re-entered on the CLI:
 *
 *  - subject: the finalized draft's `email_drafts.subject`
 *  - body:    `email_draft_finalizations.resolved_body` (exact sent body) + its hash
 *  - recipient: the exact `gmail_drafts.recipient_email` that was sent
 *  - Gmail message/thread ids + sent timestamp + confirmation status: the `send_attempts` row
 *
 * The join starts from the send_attempt (NOT from an active schedule, which is FULFILLED after a
 * successful send), so it resolves post-send. It is SELECT-only and performs no write.
 */
export interface EnrollInputData {
  attemptId: string;
  leadId: string;
  /** Raw attempt outcome fields — the caller decides eligibility (SENT_CONFIRMED / reconciled). */
  status: string;
  reconciledOutcome: string | null;
  providerMessageId: string | null;
  providerThreadId: string | null;
  /** reconciledAt (for a reconciled CONFIRMED_SENT) else completedAt. */
  sentAt: Date | null;
  /** The content hash the attempt actually sent (cross-checked against the finalization). */
  attemptFinalizedContentHash: string;
  gmailDraftId: string;
  recipientEmail: string;
  subject: string;
  body: string;
  resolvedBodyHash: string;
  finalizedEmailId: string;
  emailDraftId: string;
}

export class EnrollInputRepository {
  constructor(private readonly db: DbExecutor) {}

  async load(attemptId: string): Promise<EnrollInputData | null> {
    const rows = await this.db
      .select({
        attemptId: sendAttempts.id,
        leadId: sendAttempts.leadId,
        status: sendAttempts.status,
        reconciledOutcome: sendAttempts.reconciledOutcome,
        providerMessageId: sendAttempts.providerMessageId,
        providerThreadId: sendAttempts.providerThreadId,
        completedAt: sendAttempts.completedAt,
        reconciledAt: sendAttempts.reconciledAt,
        attemptFinalizedContentHash: sendAttempts.finalizedContentHash,
        gmailDraftId: sendAttempts.gmailDraftId,
        recipientEmail: gmailDrafts.recipientEmail,
        finalizedEmailId: emailDraftFinalizations.id,
        emailDraftId: emailDraftFinalizations.originalDraftId,
        resolvedBodyHash: emailDraftFinalizations.resolvedBodyHash,
        body: emailDraftFinalizations.resolvedBody,
        subject: emailDrafts.subject,
      })
      .from(sendAttempts)
      .innerJoin(gmailDrafts, eq(gmailDrafts.id, sendAttempts.gmailDraftId))
      .innerJoin(emailDraftFinalizations, eq(emailDraftFinalizations.id, gmailDrafts.finalizedEmailId))
      .innerJoin(emailDrafts, eq(emailDrafts.id, emailDraftFinalizations.originalDraftId))
      .where(eq(sendAttempts.id, attemptId))
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    return {
      attemptId: r.attemptId,
      leadId: r.leadId,
      status: r.status,
      reconciledOutcome: r.reconciledOutcome,
      providerMessageId: r.providerMessageId,
      providerThreadId: r.providerThreadId,
      sentAt: r.reconciledAt ?? r.completedAt,
      attemptFinalizedContentHash: r.attemptFinalizedContentHash,
      gmailDraftId: r.gmailDraftId,
      recipientEmail: r.recipientEmail,
      subject: r.subject,
      body: r.body,
      resolvedBodyHash: r.resolvedBodyHash,
      finalizedEmailId: r.finalizedEmailId,
      emailDraftId: r.emailDraftId,
    };
  }
}
