import { and, asc, desc, eq, lte } from 'drizzle-orm';
import { type DbExecutor } from '../db.js';
import {
  emailDraftFinalizations,
  emailDrafts,
  gmailDrafts,
  leads,
  outreachCampaigns,
  outreachFollowups,
  outreachMessages,
  outreachRecords,
  sendSchedules,
} from '../schema.js';
import { isOutreachStatus } from '../../domain/outreach/status.js';
import { type FollowupCandidateView } from '../../domain/outreach/followup-preparation-runner.js';
import { type ProgressionCandidateView } from '../../domain/outreach/followup-progression-runner.js';
import { type PriorSequenceMessage } from '../../prompts/email/sequence-jobs.js';

/**
 * Read-only worklists + context for the two unattended follow-up runners. SELECT-only: nothing here
 * writes, sends, drafts, or contacts Gmail. Composition, finalization, Gmail drafting, and
 * scheduling are all performed by the existing services; this repository only says WHAT is due.
 */

/** A due follow-up plus the business/campaign labels used in operator output. */
export interface DueFollowupCandidate extends FollowupCandidateView {
  campaignId: string;
  campaignName: string;
  businessName: string | null;
  contactEmail: string;
  dueAt: Date;
}

/** An approved follow-up plus its labels. */
export interface ProgressionCandidate extends ProgressionCandidateView {
  businessName: string | null;
  contactEmail: string;
}

export interface FollowupThreadContext {
  /** The subject of the FIRST message in the thread, which every follow-up replies to. */
  threadSubject: string | null;
  /** Everything already sent on this record, oldest first (untrusted data for continuity only). */
  priorMessages: PriorSequenceMessage[];
}

export class FollowupPreparationRepository {
  constructor(private readonly db: DbExecutor) {}

  /**
   * Follow-ups that are DUE now, oldest first and bounded. These are candidates only: the
   * authoritative suppression and idempotency decisions are made by the pure domain decision
   * function against the state returned here, and suppression is re-checked again before the send.
   */
  async dueCandidates(nowMs: number, limit: number, filter: { recordId?: string } = {}): Promise<DueFollowupCandidate[]> {
    if (limit <= 0) return [];
    const where = [
      eq(outreachFollowups.status, 'DUE'),
      lte(outreachFollowups.dueAt, new Date(nowMs)),
    ];
    if (filter.recordId) where.push(eq(outreachFollowups.outreachRecordId, filter.recordId));

    const rows = await this.db
      .select({
        followupId: outreachFollowups.id,
        step: outreachFollowups.step,
        dueAt: outreachFollowups.dueAt,
        outreachRecordId: outreachRecords.id,
        campaignId: outreachCampaigns.id,
        campaignName: outreachCampaigns.name,
        leadId: outreachRecords.leadId,
        leadStatus: leads.status,
        businessName: leads.businessName,
        contactEmail: outreachRecords.contactEmail,
        recordStatus: outreachRecords.status,
        doNotContact: outreachRecords.doNotContact,
      })
      .from(outreachFollowups)
      .innerJoin(outreachRecords, eq(outreachRecords.id, outreachFollowups.outreachRecordId))
      .innerJoin(outreachCampaigns, eq(outreachCampaigns.id, outreachRecords.campaignId))
      .innerJoin(leads, eq(leads.id, outreachRecords.leadId))
      .where(and(...where))
      .orderBy(asc(outreachFollowups.dueAt))
      .limit(limit);

    const out: DueFollowupCandidate[] = [];
    for (const r of rows) {
      // Idempotency: the draft already composed for this exact (record, step), if any. Its presence
      // is what makes a repeated timer run a no-op; migration 0044's partial unique index is the
      // hard backstop against two concurrent runs racing to compose the same follow-up.
      const existing = (await this.db
        .select({ id: emailDrafts.id, humanDecision: emailDrafts.humanDecision })
        .from(emailDrafts)
        .where(and(
          eq(emailDrafts.outreachRecordId, r.outreachRecordId),
          eq(emailDrafts.sequenceStep, r.step),
        ))
        .orderBy(desc(emailDrafts.createdAt))
        .limit(1))[0];
      out.push({
        ...r,
        recordStatus: isOutreachStatus(r.recordStatus) ? r.recordStatus : null,
        existingDraft: existing ? { id: existing.id, humanDecision: existing.humanDecision } : null,
      });
    }
    return out;
  }

  /**
   * Follow-up drafts whose copy a HUMAN approved and that have not yet reached the sender. Only
   * follow-ups (`sequence_step >= 1`) are returned, so an initial send is never swept into unattended
   * progression — those keep their existing manual operation exactly as today.
   */
  async progressionCandidates(limit: number, filter: { leadId?: string } = {}): Promise<ProgressionCandidate[]> {
    if (limit <= 0) return [];
    const where = [
      eq(emailDrafts.humanDecision, 'APPROVED'),
      eq(emailDrafts.status, 'APPROVED'),
    ];
    if (filter.leadId) where.push(eq(emailDrafts.leadId, filter.leadId));

    const rows = await this.db
      .select({
        leadId: emailDrafts.leadId,
        emailDraftId: emailDrafts.id,
        sequenceStep: emailDrafts.sequenceStep,
        outreachRecordId: emailDrafts.outreachRecordId,
        humanDecision: emailDrafts.humanDecision,
        humanReviewedAt: emailDrafts.humanReviewedAt,
        leadStatus: leads.status,
        businessName: leads.businessName,
      })
      .from(emailDrafts)
      .innerJoin(leads, eq(leads.id, emailDrafts.leadId))
      .where(and(...where))
      .orderBy(asc(emailDrafts.humanReviewedAt))
      .limit(limit * 4);

    const out: ProgressionCandidate[] = [];
    for (const r of rows) {
      if (out.length >= limit) break;
      // Follow-ups only, and only ones bound to an outreach record.
      if (r.sequenceStep < 1 || r.outreachRecordId === null) continue;

      const rec = (await this.db
        .select({ status: outreachRecords.status, doNotContact: outreachRecords.doNotContact, contactEmail: outreachRecords.contactEmail })
        .from(outreachRecords)
        .where(eq(outreachRecords.id, r.outreachRecordId))
        .limit(1))[0];

      const fin = (await this.db
        .select({ id: emailDraftFinalizations.id })
        .from(emailDraftFinalizations)
        .where(and(
          eq(emailDraftFinalizations.originalDraftId, r.emailDraftId),
          eq(emailDraftFinalizations.kind, 'REPLY_DIRECT'),
        ))
        .limit(1))[0];

      const draft = fin
        ? (await this.db
            .select({ id: gmailDrafts.id })
            .from(gmailDrafts)
            .where(and(eq(gmailDrafts.finalizedEmailId, fin.id), eq(gmailDrafts.outcome, 'DRAFT_CREATED')))
            .limit(1))[0]
        : undefined;

      const sched = (await this.db
        .select({ id: sendSchedules.id })
        .from(sendSchedules)
        .where(and(eq(sendSchedules.leadId, r.leadId), eq(sendSchedules.status, 'SCHEDULED')))
        .limit(1))[0];

      out.push({
        leadId: r.leadId,
        outreachRecordId: r.outreachRecordId,
        emailDraftId: r.emailDraftId,
        sequenceStep: r.sequenceStep,
        leadStatus: r.leadStatus,
        humanDecision: r.humanDecision,
        hasFinalization: fin !== undefined,
        hasGmailDraft: draft !== undefined,
        hasActiveSchedule: sched !== undefined,
        // An unrecognised stored status fails the suppression gate closed.
        recordStatus: rec && isOutreachStatus(rec.status) ? rec.status : null,
        doNotContact: rec?.doNotContact ?? false,
        businessName: r.businessName,
        contactEmail: rec?.contactEmail ?? '',
      });
    }
    return out;
  }

  /**
   * The thread a follow-up continues: the original subject plus the exact text already sent. Used
   * for continuity only — the copy may never treat it as a new source of fact.
   */
  async threadContext(outreachRecordId: string): Promise<FollowupThreadContext> {
    const rows = await this.db
      .select({
        sequenceStep: outreachMessages.sequenceStep,
        subject: outreachMessages.subject,
        body: outreachMessages.body,
      })
      .from(outreachMessages)
      .where(eq(outreachMessages.outreachRecordId, outreachRecordId))
      .orderBy(asc(outreachMessages.sequenceStep), asc(outreachMessages.createdAt));

    const priorMessages: PriorSequenceMessage[] = rows.map((r) => ({
      sequenceStep: r.sequenceStep, subject: r.subject, body: r.body,
    }));
    // Every follow-up replies to the ORIGINAL subject, not to the previous reply subject, so the
    // "Re: " prefix is applied exactly once by the renderer.
    const initial = rows.find((r) => r.sequenceStep === 0);
    return { threadSubject: initial?.subject ?? null, priorMessages };
  }
}
