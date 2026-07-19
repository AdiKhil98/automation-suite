import { and, desc, eq } from 'drizzle-orm';
import { type ScheduleRecord, type ScheduleStore } from '../../domain/schedule/schedule-service.js';
import { type DbExecutor } from '../db.js';
import { sendSchedules } from '../schema.js';

type Row = typeof sendSchedules.$inferSelect;

function toRecord(r: Row): ScheduleRecord {
  return {
    id: r.id, leadId: r.leadId, gmailDraftId: r.gmailDraftId, providerDraftId: r.providerDraftId, finalizedContentHash: r.finalizedContentHash,
    recipientEmail: r.recipientEmail, scheduledAtUtc: r.scheduledAtUtc, timezone: r.timezone, rulesVersion: r.rulesVersion, computedFrom: r.computedFrom,
    integrityFingerprint: r.integrityFingerprint, origin: r.origin, status: r.status as ScheduleRecord['status'], supersededById: r.supersededById,
    cancelReason: r.cancelReason, rescheduleCount: r.rescheduleCount,
  };
}

/** Read side of the schedule store (outside the write transaction). */
export class ScheduleRepository implements ScheduleStore {
  constructor(private readonly db: DbExecutor) {}

  async activeScheduledUtc(): Promise<Date[]> {
    const rows = await this.db.select({ at: sendSchedules.scheduledAtUtc }).from(sendSchedules).where(eq(sendSchedules.status, 'SCHEDULED'));
    return rows.map((r) => r.at);
  }
  async activeForDraft(gmailDraftId: string): Promise<ScheduleRecord | null> {
    const rows = await this.db.select().from(sendSchedules).where(and(eq(sendSchedules.gmailDraftId, gmailDraftId), eq(sendSchedules.status, 'SCHEDULED'))).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }
  async activeForLead(leadId: string): Promise<ScheduleRecord | null> {
    const rows = await this.db.select().from(sendSchedules).where(and(eq(sendSchedules.leadId, leadId), eq(sendSchedules.status, 'SCHEDULED'))).orderBy(desc(sendSchedules.createdAt)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }
}

/** Transaction-scoped writes. */
export class ScheduleTxRepository {
  constructor(private readonly db: DbExecutor) {}

  async insert(row: ScheduleRecord): Promise<void> {
    await this.db.insert(sendSchedules).values({
      id: row.id, leadId: row.leadId, gmailDraftId: row.gmailDraftId, providerDraftId: row.providerDraftId, finalizedContentHash: row.finalizedContentHash,
      recipientEmail: row.recipientEmail, scheduledAtUtc: row.scheduledAtUtc, timezone: row.timezone, rulesVersion: row.rulesVersion,
      computedFrom: row.computedFrom, integrityFingerprint: row.integrityFingerprint, origin: row.origin, status: row.status,
      supersededById: row.supersededById, cancelReason: row.cancelReason, rescheduleCount: row.rescheduleCount,
    });
  }
  async supersede(oldId: string, newId: string, now: Date): Promise<void> {
    await this.db.update(sendSchedules).set({ status: 'SUPERSEDED', supersededById: newId, updatedAt: now }).where(eq(sendSchedules.id, oldId));
  }
  async cancel(id: string, reason: string | null, now: Date): Promise<void> {
    await this.db.update(sendSchedules).set({ status: 'CANCELLED', cancelReason: reason, cancelledAt: now, updatedAt: now }).where(eq(sendSchedules.id, id));
  }
}
