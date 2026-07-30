import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { AppError } from '../../utils/errors.js';
import {
  type RecordSendInput,
  type SmokeContext,
  type SmokeContextMessage,
  type SmokeSendStore,
} from '../../domain/outreach/smoke-send.js';
import { type OutreachMessageType } from '../../domain/outreach/records.js';
import { type OutreachStatus } from '../../domain/outreach/status.js';
import { type Database, type DbExecutor } from '../db.js';
import { outreachEvents, outreachFollowups, outreachMessages, outreachRecords } from '../schema.js';

/**
 * Phase 17B persistence for the controlled smoke send. Every write goes through a single
 * transaction so the message-id attachment, the record transition, the immutable events, and the
 * tracking-only follow-up commit or roll back together. It NEVER mutates a stored message's
 * subject/body/content_hash — only the delivery metadata (gmail ids + sent_at) is attached.
 */
export class OutreachSmokeRepository implements SmokeSendStore {
  constructor(private readonly db: Database) {}

  async load(recordId: string): Promise<SmokeContext | null> {
    const recRows = await this.db.select().from(outreachRecords).where(eq(outreachRecords.id, recordId)).limit(1);
    const rec = recRows[0];
    if (!rec) return null;

    const msgRows = await this.db
      .select()
      .from(outreachMessages)
      .where(and(eq(outreachMessages.outreachRecordId, recordId), eq(outreachMessages.messageType, 'INITIAL'), eq(outreachMessages.sequenceStep, 0)))
      .orderBy(asc(outreachMessages.createdAt))
      .limit(1);
    const m = msgRows[0];
    const message: SmokeContextMessage | null = m
      ? {
          id: m.id,
          messageType: m.messageType as OutreachMessageType,
          sequenceStep: m.sequenceStep,
          subject: m.subject,
          body: m.body,
          contentHash: m.contentHash,
          approvedAt: m.approvedAt,
          sentAt: m.sentAt,
          gmailMessageId: m.gmailMessageId,
          gmailThreadId: m.gmailThreadId,
        }
      : null;

    // Any already-sent message for this record is a defensive duplicate signal.
    const sentRows = await this.db
      .select({ id: outreachMessages.id })
      .from(outreachMessages)
      .where(and(eq(outreachMessages.outreachRecordId, recordId), sql`${outreachMessages.sentAt} IS NOT NULL`))
      .limit(1);

    return {
      record: {
        id: rec.id,
        status: rec.status as OutreachStatus,
        contactEmail: rec.contactEmail,
        doNotContact: rec.doNotContact,
        timezone: rec.timezone,
        campaignId: rec.campaignId,
        leadId: rec.leadId,
      },
      message,
      priorSuccessfulSend: sentRows.length > 0,
    };
  }

  async recordSend(input: RecordSendInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      const now = new Date();

      // Re-read the message inside the transaction and refuse if it was already sent (idempotency:
      // a reconcile after a persistence failure never double-attaches).
      const cur = await tx.select().from(outreachMessages).where(eq(outreachMessages.id, input.messageId)).limit(1);
      const msg = cur[0];
      if (!msg) throw new AppError('OUTREACH_MESSAGE_NOT_FOUND', `message not found: ${input.messageId}`);
      if (msg.sentAt !== null || msg.gmailMessageId !== null) {
        throw new AppError('OUTREACH_ALREADY_SENT', 'message already has a recorded send');
      }

      // Attach ONLY delivery metadata (never subject/body/content_hash).
      await tx
        .update(outreachMessages)
        .set({ gmailMessageId: input.gmailMessageId, gmailThreadId: input.gmailThreadId, sentAt: input.sentAt })
        .where(eq(outreachMessages.id, input.messageId));

      // Advance the record: INITIAL_SENT, record the send time, arm the tracking follow-up.
      await tx
        .update(outreachRecords)
        .set({ status: 'INITIAL_SENT', lastSentAt: input.sentAt, nextFollowupAt: input.followup.dueAt, updatedAt: now })
        .where(eq(outreachRecords.id, input.recordId));

      await appendEvent(tx, {
        outreachRecordId: input.recordId,
        type: 'STATE_TRANSITION',
        fromStatus: input.fromStatus,
        toStatus: 'INITIAL_SENT',
        message: `${input.fromStatus} -> INITIAL_SENT (Phase 17B smoke send)`,
        data: { providerMessageId: input.providerMessageId },
      });
      await appendEvent(tx, {
        outreachRecordId: input.recordId,
        type: 'NOTE',
        fromStatus: null,
        toStatus: null,
        message: 'INITIAL email sent (Phase 17B controlled smoke test)',
        data: { gmailMessageId: input.gmailMessageId, gmailThreadId: input.gmailThreadId },
      });

      // Tracking-only follow-up (DUE): created but NEVER sent by Phase 17B.
      await tx.insert(outreachFollowups).values({
        id: input.followup.id,
        outreachRecordId: input.recordId,
        step: input.followup.step,
        dueAt: input.followup.dueAt,
        timezone: input.followup.timezone,
        status: 'DUE',
        blockedReason: null,
        cancelledReason: null,
        createdAt: now,
        updatedAt: now,
      });
      await appendEvent(tx, {
        outreachRecordId: input.recordId,
        type: 'FOLLOWUP_SCHEDULED',
        fromStatus: null,
        toStatus: null,
        message: `Follow-up 1 due ${input.followup.dueAt.toISOString()} (tracking only; never auto-sent)`,
        data: { step: input.followup.step, dueAt: input.followup.dueAt.toISOString() },
      });
    });
  }

  /**
   * Record the human approval for the INITIAL message and move the record to APPROVED_TO_SEND.
   * Sets ONLY the approval timestamp on the message; the content stays immutable.
   */
  async approve(recordId: string, messageId: string, approver: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const now = new Date();
      const recRows = await tx.select().from(outreachRecords).where(eq(outreachRecords.id, recordId)).limit(1);
      const rec = recRows[0];
      if (!rec) throw new AppError('OUTREACH_RECORD_NOT_FOUND', `record not found: ${recordId}`);
      if (rec.status !== 'AWAITING_APPROVAL') {
        throw new AppError('OUTREACH_NOT_AWAITING_APPROVAL', `record status must be AWAITING_APPROVAL (is ${rec.status})`);
      }
      await tx.update(outreachMessages).set({ approvedAt: now }).where(eq(outreachMessages.id, messageId));
      await tx.update(outreachRecords).set({ status: 'APPROVED_TO_SEND', updatedAt: now }).where(eq(outreachRecords.id, recordId));
      await appendEvent(tx, {
        outreachRecordId: recordId,
        type: 'STATE_TRANSITION',
        fromStatus: 'AWAITING_APPROVAL',
        toStatus: 'APPROVED_TO_SEND',
        message: `Human approval recorded by ${approver}`,
        data: { approver, messageId },
      });
    });
  }
}

async function appendEvent(
  tx: DbExecutor,
  evt: { outreachRecordId: string; type: string; fromStatus: string | null; toStatus: string | null; message: string; data: unknown },
): Promise<void> {
  const [maxRow] = await tx
    .select({ max: sql<number>`COALESCE(MAX(${outreachEvents.seq}), 0)` })
    .from(outreachEvents)
    .where(eq(outreachEvents.outreachRecordId, evt.outreachRecordId));
  const seq = Number(maxRow?.max ?? 0) + 1;
  await tx.insert(outreachEvents).values({
    id: randomUUID(),
    outreachRecordId: evt.outreachRecordId,
    seq,
    type: evt.type,
    fromStatus: evt.fromStatus,
    toStatus: evt.toStatus,
    message: evt.message,
    data: evt.data ?? null,
  });
}
