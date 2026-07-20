import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  type SendAttemptRecord,
  type SendStore,
  type SendingReadinessRecord,
} from '../../domain/send/send-service.js';
import { type DbExecutor } from '../db.js';
import { sendAttempts, sendSchedules, sendingReadinessApprovals, suppressionList } from '../schema.js';

const BLOCKING: SendAttemptRecord['status'][] = ['RESERVED', 'CALL_STARTED', 'OUTCOME_UNKNOWN'];

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === '23505';
}

/** Read + reserve side of the send store (outside the completion transaction). */
export class SendRepository implements SendStore {
  constructor(private readonly db: DbExecutor) {}

  async readiness(gmailAccount: string, policyVersion: string): Promise<SendingReadinessRecord | null> {
    const rows = await this.db
      .select()
      .from(sendingReadinessApprovals)
      .where(and(eq(sendingReadinessApprovals.gmailAccount, gmailAccount), eq(sendingReadinessApprovals.policyVersion, policyVersion)))
      .orderBy(desc(sendingReadinessApprovals.approvedAt))
      .limit(1);
    const r = rows[0];
    return r
      ? { id: r.id, gmailAccount: r.gmailAccount, policyVersion: r.policyVersion, approvedBy: r.approvedBy, approvedAt: r.approvedAt, expiresAt: r.expiresAt, revokedAt: r.revokedAt }
      : null;
  }

  async isEmailSuppressed(email: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: suppressionList.id })
      .from(suppressionList)
      .where(and(eq(suppressionList.scope, 'email'), eq(suppressionList.value, email.trim().toLowerCase())))
      .limit(1);
    return rows.length > 0;
  }

  async hasConfirmedAttempt(scheduleId: string): Promise<boolean> {
    const rows = await this.db.select({ id: sendAttempts.id }).from(sendAttempts).where(and(eq(sendAttempts.scheduleId, scheduleId), eq(sendAttempts.status, 'SENT_CONFIRMED'))).limit(1);
    return rows.length > 0;
  }

  async hasBlockingAttempt(scheduleId: string): Promise<boolean> {
    const rows = await this.db.select({ id: sendAttempts.id }).from(sendAttempts).where(and(eq(sendAttempts.scheduleId, scheduleId), inArray(sendAttempts.status, BLOCKING))).limit(1);
    return rows.length > 0;
  }

  async lastDefinitiveFailureAt(scheduleId: string): Promise<Date | null> {
    const rows = await this.db.select({ at: sendAttempts.completedAt }).from(sendAttempts)
      .where(and(eq(sendAttempts.scheduleId, scheduleId), eq(sendAttempts.status, 'DEFINITIVE_FAILURE')))
      .orderBy(desc(sendAttempts.completedAt)).limit(1);
    return rows[0]?.at ?? null;
  }

  async promoteStartedToUnknown(scheduleId: string, now: Date): Promise<void> {
    await this.db.update(sendAttempts).set({ status: 'OUTCOME_UNKNOWN', errorClass: 'crash_after_call_started', completedAt: now })
      .where(and(eq(sendAttempts.scheduleId, scheduleId), eq(sendAttempts.status, 'CALL_STARTED')));
  }

  async reserveAttempt(row: SendAttemptRecord): Promise<boolean> {
    try {
      await this.db.insert(sendAttempts).values(toInsert(row));
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }
}

/** Transaction-scoped writes for the terminal send outcome. */
export class SendTxRepository {
  constructor(private readonly db: DbExecutor) {}

  async completeAttempt(id: string, patch: Partial<SendAttemptRecord>): Promise<void> {
    const set: Record<string, unknown> = {};
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.providerMessageId !== undefined) set.providerMessageId = patch.providerMessageId;
    if (patch.providerThreadId !== undefined) set.providerThreadId = patch.providerThreadId;
    if (patch.errorClass !== undefined) set.errorClass = patch.errorClass;
    if (patch.callStartedAt !== undefined) set.callStartedAt = patch.callStartedAt;
    if (patch.completedAt !== undefined) set.completedAt = patch.completedAt;
    if (Object.keys(set).length > 0) await this.db.update(sendAttempts).set(set).where(eq(sendAttempts.id, id));
  }

  async markScheduleFulfilled(scheduleId: string, now: Date): Promise<void> {
    await this.db.update(sendSchedules).set({ status: 'FULFILLED', fulfilledAt: now, updatedAt: now }).where(eq(sendSchedules.id, scheduleId));
  }

  async invalidateSchedule(scheduleId: string, reason: string, now: Date): Promise<void> {
    await this.db.update(sendSchedules).set({ status: 'INVALIDATED', invalidatedAt: now, invalidationReason: reason, updatedAt: now }).where(eq(sendSchedules.id, scheduleId));
  }
}

function toInsert(row: SendAttemptRecord): typeof sendAttempts.$inferInsert {
  return {
    id: row.id,
    leadId: row.leadId,
    scheduleId: row.scheduleId,
    gmailDraftId: row.gmailDraftId,
    readinessApprovalId: row.readinessApprovalId,
    gmailAccount: row.gmailAccount,
    recipientHash: row.recipientHash,
    finalizedContentHash: row.finalizedContentHash,
    scheduleIntegrityFingerprint: row.scheduleIntegrityFingerprint,
    approvedEnvelopeHash: row.approvedEnvelopeHash,
    observedEnvelopeHash: row.observedEnvelopeHash,
    sendFingerprint: row.sendFingerprint,
    confirmationFingerprint: row.confirmationFingerprint,
    confirmedBy: row.confirmedBy,
    confirmedAt: row.confirmedAt,
    status: row.status,
    providerMessageId: row.providerMessageId,
    providerThreadId: row.providerThreadId,
    errorClass: row.errorClass,
    reservedAt: row.reservedAt,
    callStartedAt: row.callStartedAt,
    completedAt: row.completedAt,
  };
}
