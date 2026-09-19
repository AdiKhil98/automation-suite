import { desc, eq, inArray, sql } from 'drizzle-orm';
import { type LeadStatus } from '../../domain/leads/status.js';
import { isOutreachStatus, type OutreachStatus } from '../../domain/outreach/status.js';
import { type DbExecutor } from '../db.js';
import {
  emailDraftFinalizations, emailDrafts, gmailDrafts, leads, outreachFollowups, outreachRecords, sendSchedules,
} from '../schema.js';

/**
 * Read-only queries for the `backlog-status` CLI report. SELECT-only: no write, no send, no Gmail,
 * no paid call. Every method here is a bounded, bulk query — deliberately never a per-lead loop —
 * so the report keeps working as the leads table grows into the hundreds/thousands.
 */
export class BacklogStatusRepository {
  constructor(private readonly db: DbExecutor) {}

  /** One row per distinct leads.status with its count. */
  async countLeadsByStatus(): Promise<Map<string, number>> {
    const rows = await this.db.select({ status: leads.status, n: sql<number>`count(*)::int` })
      .from(leads).groupBy(leads.status);
    return new Map(rows.map((r) => [r.status, r.n]));
  }

  /** Lead ids currently in any of the given statuses. */
  async leadIdsWithStatus(statuses: readonly LeadStatus[]): Promise<string[]> {
    if (statuses.length === 0) return [];
    const rows = await this.db.select({ id: leads.id }).from(leads).where(inArray(leads.status, statuses as string[]));
    return rows.map((r) => r.id);
  }

  /**
   * Latest email_drafts.sequence_step per lead id, ONE bulk query (no N+1): every draft row for the
   * given leads, newest first, reduced client-side to the first (= latest) row per lead. This is the
   * only way to tell whether a lead currently sitting in a shared status (READY_FOR_HUMAN_APPROVAL,
   * FINALIZED_EMAIL_PENDING, HUMAN_APPROVED, DRAFT_CREATED, SCHEDULED) is there for its initial email
   * (sequence_step 0) or a follow-up (>=1) — that status is genuinely reused across both.
   */
  async latestDraftStepByLead(leadIds: readonly string[]): Promise<Map<string, number>> {
    if (leadIds.length === 0) return new Map();
    const rows = await this.db.select({
      leadId: emailDrafts.leadId, sequenceStep: emailDrafts.sequenceStep, createdAt: emailDrafts.createdAt,
    }).from(emailDrafts).where(inArray(emailDrafts.leadId, leadIds as string[])).orderBy(desc(emailDrafts.createdAt));
    const out = new Map<string, number>();
    for (const r of rows) if (!out.has(r.leadId)) out.set(r.leadId, r.sequenceStep);
    return out;
  }

  /** Minimal identity fields needed by SuppressionRepository.isSuppressed(), for a bounded lead-id set. */
  async leadIdentities(leadIds: readonly string[]): Promise<Map<string, {
    id: string; normalizedName: string | null; normalizedDomain: string | null; normalizedPhone: string | null; placeId: string | null;
  }>> {
    if (leadIds.length === 0) return new Map();
    const rows = await this.db.select({
      id: leads.id, normalizedName: leads.normalizedName, normalizedDomain: leads.normalizedDomain,
      normalizedPhone: leads.normalizedPhone, placeId: leads.placeId,
    }).from(leads).where(inArray(leads.id, leadIds as string[]));
    return new Map(rows.map((r) => [r.id, r]));
  }

  /**
   * Every outreach_records row for the given leads (a lead may have more than one across
   * campaigns) — used for the authoritative blocked-inventory check (fix #4). Bulk, bounded to the
   * candidate set, never a per-lead query.
   */
  async outreachRecordsForLeads(leadIds: readonly string[]): Promise<Array<{ leadId: string; status: OutreachStatus | null; doNotContact: boolean }>> {
    if (leadIds.length === 0) return [];
    const rows = await this.db.select({
      leadId: outreachRecords.leadId, status: outreachRecords.status, doNotContact: outreachRecords.doNotContact,
    }).from(outreachRecords).where(inArray(outreachRecords.leadId, leadIds as string[]));
    return rows.map((r) => ({ leadId: r.leadId, status: isOutreachStatus(r.status) ? r.status : null, doNotContact: r.doNotContact }));
  }

  /** status + do_not_contact + count for every outreach_records row — feeds TOTAL_REMAINING (section C). */
  async outreachRecordStateCounts(): Promise<Array<{ status: OutreachStatus | null; doNotContact: boolean; count: number }>> {
    const rows = await this.db.select({
      status: outreachRecords.status, doNotContact: outreachRecords.doNotContact, n: sql<number>`count(*)::int`,
    }).from(outreachRecords).groupBy(outreachRecords.status, outreachRecords.doNotContact);
    return rows.map((r) => ({ status: isOutreachStatus(r.status) ? r.status : null, doNotContact: r.doNotContact, count: r.n }));
  }

  /** Every outreach_followups row with status='DUE' — unbounded by date; day-placement happens in the domain layer. */
  async dueFollowups(): Promise<Array<{ outreachRecordId: string; step: number; dueAt: Date }>> {
    return this.db.select({
      outreachRecordId: outreachFollowups.outreachRecordId, step: outreachFollowups.step, dueAt: outreachFollowups.dueAt,
    }).from(outreachFollowups).where(eq(outreachFollowups.status, 'DUE'));
  }

  /**
   * Every currently-active (status='SCHEDULED') send_schedules row, with the driving
   * email_drafts.sequence_step and outreach_record_id resolved through the same
   * gmail_draft -> finalization -> email_draft chain FollowupSendContextRepository uses for the
   * final pre-send check. Unbounded by date: this set is inherently small (bounded by the daily
   * send cap over the platform's scheduling horizon, never the full leads table), so a single
   * unfiltered read is both correct and cheap. Callers bucket by day themselves.
   */
  async activeScheduledSends(): Promise<Array<{
    leadId: string; scheduledAtUtc: Date; sequenceStep: number; outreachRecordId: string | null;
  }>> {
    return this.db.select({
      leadId: sendSchedules.leadId,
      scheduledAtUtc: sendSchedules.scheduledAtUtc,
      sequenceStep: emailDrafts.sequenceStep,
      outreachRecordId: emailDrafts.outreachRecordId,
    })
      .from(sendSchedules)
      .innerJoin(gmailDrafts, eq(gmailDrafts.id, sendSchedules.gmailDraftId))
      .innerJoin(emailDraftFinalizations, eq(emailDraftFinalizations.id, gmailDrafts.finalizedEmailId))
      .innerJoin(emailDrafts, eq(emailDrafts.id, emailDraftFinalizations.originalDraftId))
      .where(eq(sendSchedules.status, 'SCHEDULED'));
  }
}
