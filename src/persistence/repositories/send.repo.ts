import { and, count, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import {
  type SendAttemptRecord,
  type SendStore,
  type SendingReadinessRecord,
} from '../../domain/send/send-service.js';
import { type Database, type DbExecutor } from '../db.js';
import { sendAttempts, sendSchedules, sendingReadinessApprovals, suppressionList } from '../schema.js';

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === '23505';
}

/** Read + reserve side of the send store (outside the completion transaction). */
export class SendRepository implements SendStore {
  constructor(private readonly db: Database) {}

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
    const rows = await this.db.select({ id: sendAttempts.id }).from(sendAttempts).where(and(eq(sendAttempts.scheduleId, scheduleId),
      or(eq(sendAttempts.status, 'SENT_CONFIRMED'), eq(sendAttempts.reconciledOutcome, 'CONFIRMED_SENT')))).limit(1);
    return rows.length > 0;
  }

  async hasBlockingAttempt(scheduleId: string): Promise<boolean> {
    const rows = await this.db.select({ id: sendAttempts.id }).from(sendAttempts).where(and(eq(sendAttempts.scheduleId, scheduleId),
      or(inArray(sendAttempts.status, ['RESERVED', 'CALL_STARTED']), and(eq(sendAttempts.status, 'OUTCOME_UNKNOWN'),
        or(isNull(sendAttempts.reconciledOutcome), ne(sendAttempts.reconciledOutcome, 'CONFIRMED_NOT_SENT')))))).limit(1);
    return rows.length > 0;
  }

  async lastDefinitiveFailureAt(scheduleId: string): Promise<Date | null> {
    const rows = await this.db.select({ completedAt: sendAttempts.completedAt,
      reconciledAt: sendAttempts.reconciledAt }).from(sendAttempts)
      .where(and(eq(sendAttempts.scheduleId, scheduleId), or(eq(sendAttempts.status, 'DEFINITIVE_FAILURE'),
        eq(sendAttempts.reconciledOutcome, 'CONFIRMED_NOT_SENT'))));
    return rows.map((r) => r.reconciledAt ?? r.completedAt).filter((v): v is Date => v !== null)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  }

  async confirmedSendsToday(gmailAccount: string, now: Date): Promise<number> {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const end = new Date(start.getTime() + 24 * 60 * 60_000);
    const effectiveAt = sql<Date>`COALESCE(${sendAttempts.reconciledAt}, ${sendAttempts.completedAt})`;
    const rows = await this.db.select({ value: count() }).from(sendAttempts).where(and(
      eq(sendAttempts.gmailAccount, gmailAccount), or(eq(sendAttempts.status, 'SENT_CONFIRMED'),
        eq(sendAttempts.reconciledOutcome, 'CONFIRMED_SENT')),
      gte(effectiveAt, start), lt(effectiveAt, end),
    ));
    return rows[0]?.value ?? 0;
  }

  async promoteStartedToUnknown(scheduleId: string, now: Date): Promise<void> {
    await this.db.update(sendAttempts).set({ status: 'OUTCOME_UNKNOWN', errorClass: 'crash_after_call_started', completedAt: now })
      .where(and(eq(sendAttempts.scheduleId, scheduleId), eq(sendAttempts.status, 'CALL_STARTED')));
  }

  reserveAttempt(row: SendAttemptRecord, dailyCap: number): Promise<'reserved' | 'duplicate' | 'daily_cap'> {
    return this.db.transaction(async (tx) => {
      const start = new Date(Date.UTC(row.reservedAt.getUTCFullYear(), row.reservedAt.getUTCMonth(), row.reservedAt.getUTCDate()));
      const end = new Date(start.getTime() + 24 * 60 * 60_000);
      // Serializes reservations for one account/day. Collisions only serialize unrelated accounts;
      // they cannot weaken the cap. The lock is released automatically with this transaction.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`send-cap|${row.gmailAccount}|${start.toISOString()}`}))`);
      const effectiveAt = sql<Date>`COALESCE(${sendAttempts.reconciledAt}, ${sendAttempts.completedAt})`;
      const counted = await tx.select({ value: count() }).from(sendAttempts).where(and(
        eq(sendAttempts.gmailAccount, row.gmailAccount), or(
          and(or(eq(sendAttempts.status, 'SENT_CONFIRMED'), eq(sendAttempts.reconciledOutcome, 'CONFIRMED_SENT')),
            gte(effectiveAt, start), lt(effectiveAt, end)),
          and(inArray(sendAttempts.status, ['RESERVED', 'CALL_STARTED']), gte(sendAttempts.reservedAt, start), lt(sendAttempts.reservedAt, end)),
          and(eq(sendAttempts.status, 'OUTCOME_UNKNOWN'), or(isNull(sendAttempts.reconciledOutcome),
            ne(sendAttempts.reconciledOutcome, 'CONFIRMED_NOT_SENT')), gte(sendAttempts.reservedAt, start), lt(sendAttempts.reservedAt, end)),
        )));
      if ((counted[0]?.value ?? 0) >= dailyCap) return 'daily_cap';
      try { await tx.insert(sendAttempts).values(toInsert(row)); return 'reserved'; }
      catch (err) { if (isUniqueViolation(err)) return 'duplicate'; throw err; }
    });
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
