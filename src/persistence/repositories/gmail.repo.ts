import { and, desc, eq, gte, notInArray, sql } from 'drizzle-orm';
import { type GmailDraftRecord, type GmailStore } from '../../domain/gmail/gmail-service.js';
import { type DbExecutor } from '../db.js';
import { gmailDrafts } from '../schema.js';

type Row = typeof gmailDrafts.$inferSelect;

function toRecord(r: Row): GmailDraftRecord {
  return {
    id: r.id, leadId: r.leadId, finalizedEmailId: r.finalizedEmailId, recipientEmail: r.recipientEmail, senderEmail: r.senderEmail,
    gmailAccount: r.gmailAccount, provider: r.provider, providerDraftId: r.providerDraftId, threadId: r.threadId, messageId: r.messageId,
    idempotencyFingerprint: r.idempotencyFingerprint, sourceEmailVersion: r.sourceEmailVersion, outcome: r.outcome as GmailDraftRecord['outcome'],
    errorClass: r.errorClass, createdAt: r.createdAt, completedAt: r.completedAt,
  };
}

/** Read + reserve side of the Gmail draft store (outside the completion transaction). */
export class GmailRepository implements GmailStore {
  constructor(private readonly db: DbExecutor) {}

  async draftsToday(now: Date): Promise<number> {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const rows = await this.db.select({ n: sql<number>`count(*)::int` }).from(gmailDrafts).where(gte(gmailDrafts.createdAt, start));
    return rows[0]?.n ?? 0;
  }
  async lastAttemptAt(): Promise<Date | null> {
    const rows = await this.db.select().from(gmailDrafts).orderBy(desc(gmailDrafts.createdAt)).limit(1);
    return rows[0]?.createdAt ?? null;
  }
  async existingByFingerprint(account: string, fingerprint: string): Promise<boolean> {
    const rows = await this.db.select({ id: gmailDrafts.id }).from(gmailDrafts)
      .where(and(eq(gmailDrafts.gmailAccount, account), eq(gmailDrafts.idempotencyFingerprint, fingerprint), eq(gmailDrafts.outcome, 'DRAFT_CREATED'))).limit(1);
    return rows.length > 0;
  }
  async findReservedByFingerprint(fingerprint: string): Promise<GmailDraftRecord | null> {
    const rows = await this.db.select().from(gmailDrafts)
      .where(and(eq(gmailDrafts.idempotencyFingerprint, fingerprint), notInArray(gmailDrafts.outcome, ['DRAFT_CREATED', 'DUPLICATE_REUSED'])))
      .orderBy(desc(gmailDrafts.createdAt)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }
  async reserveRun(row: GmailDraftRecord): Promise<void> {
    await this.db.insert(gmailDrafts).values({
      id: row.id, leadId: row.leadId, finalizedEmailId: row.finalizedEmailId, recipientEmail: row.recipientEmail, senderEmail: row.senderEmail,
      gmailAccount: row.gmailAccount, provider: row.provider, providerDraftId: row.providerDraftId, threadId: row.threadId, messageId: row.messageId,
      idempotencyFingerprint: row.idempotencyFingerprint, sourceEmailVersion: row.sourceEmailVersion, outcome: row.outcome, errorClass: row.errorClass,
      createdAt: row.createdAt, completedAt: row.completedAt,
    });
  }
}

/** Transaction-scoped completion writes. */
export class GmailTxRepository {
  constructor(private readonly db: DbExecutor) {}

  async completeRun(runId: string, patch: Partial<GmailDraftRecord>): Promise<void> {
    if (!runId) return;
    const set: Record<string, unknown> = {};
    if (patch.outcome !== undefined) set.outcome = patch.outcome;
    if (patch.providerDraftId !== undefined) set.providerDraftId = patch.providerDraftId;
    if (patch.threadId !== undefined) set.threadId = patch.threadId;
    if (patch.messageId !== undefined) set.messageId = patch.messageId;
    if (patch.errorClass !== undefined) set.errorClass = patch.errorClass;
    if (patch.completedAt !== undefined) set.completedAt = patch.completedAt;
    if (Object.keys(set).length > 0) await this.db.update(gmailDrafts).set(set).where(eq(gmailDrafts.id, runId));
  }
}
