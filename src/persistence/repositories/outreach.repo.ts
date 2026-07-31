import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { type NewOutreachEvent, type OutreachEvent } from '../../domain/outreach/events.js';
import {
  type OutreachTxRepos,
} from '../../domain/outreach/outreach-service.js';
import {
  type OutreachCampaign,
  type OutreachDeliveryEvent,
  type OutreachFollowup,
  type OutreachMessage,
  type OutreachRecord,
} from '../../domain/outreach/records.js';
import { type TrackedOutbound } from '../../domain/outreach/delivery.js';
import {
  type FollowupRowView,
  type MessageRowView,
  type OutreachProjection,
  type OutreachRowView,
  type ReplyRowView,
} from '../../domain/outreach/sheet-sync.js';
import { type TrackedThread } from '../../domain/outreach/reply-sync.js';
import { type OutreachStatus } from '../../domain/outreach/status.js';
import { type DbExecutor } from '../db.js';
import {
  demoDeploymentRuns,
  leads,
  outreachCampaigns,
  outreachDeliveryEvents,
  outreachEvents,
  outreachFollowups,
  outreachMessages,
  outreachRecords,
  outreachReplies,
  qualificationResults,
} from '../schema.js';

type RecordRow = typeof outreachRecords.$inferSelect;
type FollowupRow = typeof outreachFollowups.$inferSelect;

function toRecord(r: RecordRow): OutreachRecord {
  return {
    id: r.id,
    campaignId: r.campaignId,
    leadId: r.leadId,
    contactEmail: r.contactEmail,
    status: r.status as OutreachStatus,
    sequenceStep: r.sequenceStep,
    owner: r.owner,
    timezone: r.timezone,
    lastSentAt: r.lastSentAt,
    nextFollowupAt: r.nextFollowupAt,
    lastReplyAt: r.lastReplyAt,
    replyCategory: r.replyCategory,
    doNotContact: r.doNotContact,
    outcome: r.outcome,
    notes: r.notes,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toFollowup(r: FollowupRow): OutreachFollowup {
  return {
    id: r.id,
    outreachRecordId: r.outreachRecordId,
    step: r.step,
    dueAt: r.dueAt,
    timezone: r.timezone,
    status: r.status as OutreachFollowup['status'],
    blockedReason: r.blockedReason,
    cancelledReason: r.cancelledReason,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

const TERMINAL_SQL = sql`('UNSUBSCRIBED','DO_NOT_CONTACT','CLOSED_WON','CLOSED_LOST')`;

/** Transaction-scoped writes implementing the domain OutreachTxRepos port. */
export class OutreachTxRepository implements OutreachTxRepos {
  constructor(private readonly db: DbExecutor) {}

  async getRecord(id: string): Promise<OutreachRecord | null> {
    const rows = await this.db.select().from(outreachRecords).where(eq(outreachRecords.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findActiveRecord(
    campaignId: string,
    leadId: string,
    contactEmail: string,
  ): Promise<OutreachRecord | null> {
    const rows = await this.db
      .select()
      .from(outreachRecords)
      .where(
        and(
          eq(outreachRecords.campaignId, campaignId),
          eq(outreachRecords.leadId, leadId),
          eq(outreachRecords.contactEmail, contactEmail),
          sql`${outreachRecords.status} NOT IN ${TERMINAL_SQL}`,
        ),
      )
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async hasDoNotContact(contactEmail: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: outreachRecords.id })
      .from(outreachRecords)
      .where(
        and(
          eq(outreachRecords.contactEmail, contactEmail),
          sql`(${outreachRecords.doNotContact} = true OR ${outreachRecords.status} IN ('DO_NOT_CONTACT','UNSUBSCRIBED'))`,
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async insertRecord(rec: OutreachRecord): Promise<void> {
    await this.db.insert(outreachRecords).values({
      id: rec.id,
      campaignId: rec.campaignId,
      leadId: rec.leadId,
      contactEmail: rec.contactEmail,
      status: rec.status,
      sequenceStep: rec.sequenceStep,
      owner: rec.owner,
      timezone: rec.timezone,
      lastSentAt: rec.lastSentAt,
      nextFollowupAt: rec.nextFollowupAt,
      lastReplyAt: rec.lastReplyAt,
      replyCategory: rec.replyCategory,
      doNotContact: rec.doNotContact,
      outcome: rec.outcome,
      notes: rec.notes,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
    });
  }

  async updateRecord(id: string, patch: Partial<OutreachRecord>, now: Date): Promise<void> {
    const set: Record<string, unknown> = { updatedAt: now };
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.sequenceStep !== undefined) set.sequenceStep = patch.sequenceStep;
    if (patch.owner !== undefined) set.owner = patch.owner;
    if (patch.lastSentAt !== undefined) set.lastSentAt = patch.lastSentAt;
    if (patch.nextFollowupAt !== undefined) set.nextFollowupAt = patch.nextFollowupAt;
    if (patch.lastReplyAt !== undefined) set.lastReplyAt = patch.lastReplyAt;
    if (patch.replyCategory !== undefined) set.replyCategory = patch.replyCategory;
    if (patch.doNotContact !== undefined) set.doNotContact = patch.doNotContact;
    if (patch.outcome !== undefined) set.outcome = patch.outcome;
    if (patch.notes !== undefined) set.notes = patch.notes;
    await this.db.update(outreachRecords).set(set).where(eq(outreachRecords.id, id));
  }

  async insertMessage(msg: OutreachMessage): Promise<void> {
    await this.db.insert(outreachMessages).values({
      id: msg.id,
      outreachRecordId: msg.outreachRecordId,
      messageType: msg.messageType,
      sequenceStep: msg.sequenceStep,
      subject: msg.subject,
      body: msg.body,
      contentHash: msg.contentHash,
      emailDraftId: msg.emailDraftId,
      finalizedEmailId: msg.finalizedEmailId,
      gmailMessageId: msg.gmailMessageId,
      gmailThreadId: msg.gmailThreadId,
      approvedAt: msg.approvedAt,
      sentAt: msg.sentAt,
      createdAt: msg.createdAt,
    });
  }

  async insertReply(reply: {
    id: string;
    outreachRecordId: string;
    gmailThreadId: string;
    gmailMessageId: string;
    fromEmail: string;
    receivedAt: Date;
    classification: string;
    preview: string;
  }): Promise<void> {
    await this.db.insert(outreachReplies).values(reply);
  }

  async insertFollowup(f: OutreachFollowup): Promise<void> {
    await this.db.insert(outreachFollowups).values({
      id: f.id,
      outreachRecordId: f.outreachRecordId,
      step: f.step,
      dueAt: f.dueAt,
      timezone: f.timezone,
      status: f.status,
      blockedReason: f.blockedReason,
      cancelledReason: f.cancelledReason,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
    });
  }

  async updateFollowupStatus(
    id: string,
    status: OutreachFollowup['status'],
    reason: string | null,
    now: Date,
  ): Promise<void> {
    await this.db
      .update(outreachFollowups)
      .set({ status, cancelledReason: reason, updatedAt: now })
      .where(eq(outreachFollowups.id, id));
  }

  async pendingFollowups(recordId: string): Promise<OutreachFollowup[]> {
    const rows = await this.db
      .select()
      .from(outreachFollowups)
      .where(
        and(
          eq(outreachFollowups.outreachRecordId, recordId),
          inArray(outreachFollowups.status, ['DUE', 'POSTPONED']),
        ),
      );
    return rows.map(toFollowup);
  }

  async appendEvent(evt: NewOutreachEvent): Promise<number> {
    const [maxRow] = await this.db
      .select({ max: sql<number>`COALESCE(MAX(${outreachEvents.seq}), 0)` })
      .from(outreachEvents)
      .where(eq(outreachEvents.outreachRecordId, evt.outreachRecordId));
    const seq = Number(maxRow?.max ?? 0) + 1;
    await this.db.insert(outreachEvents).values({
      id: randomUUID(),
      outreachRecordId: evt.outreachRecordId,
      seq,
      type: evt.type,
      fromStatus: evt.fromStatus,
      toStatus: evt.toStatus,
      message: evt.message,
      data: evt.data ?? null,
    });
    return seq;
  }

  async deliveryEventExists(dsnGmailMessageId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: outreachDeliveryEvents.id })
      .from(outreachDeliveryEvents)
      .where(eq(outreachDeliveryEvents.dsnGmailMessageId, dsnGmailMessageId))
      .limit(1);
    return rows.length > 0;
  }

  async insertDeliveryEvent(evt: OutreachDeliveryEvent): Promise<void> {
    await this.db.insert(outreachDeliveryEvents).values({
      id: evt.id,
      outreachRecordId: evt.outreachRecordId,
      outreachMessageId: evt.outreachMessageId,
      deliveryStatus: evt.deliveryStatus,
      permanence: evt.permanence,
      rejectionCode: evt.rejectionCode,
      diagnosticText: evt.diagnosticText,
      dsnStatus: evt.dsnStatus,
      dsnAction: evt.dsnAction,
      finalRecipient: evt.finalRecipient,
      originalRecipient: evt.originalRecipient,
      bounceAt: evt.bounceAt,
      originalGmailMessageId: evt.originalGmailMessageId,
      originalGmailThreadId: evt.originalGmailThreadId,
      dsnGmailMessageId: evt.dsnGmailMessageId,
      dsnGmailThreadId: evt.dsnGmailThreadId,
      preview: evt.preview,
      createdAt: evt.createdAt,
    });
  }
}

/** Read side: campaigns, records, timelines, projections, readiness — no writes. */
export class OutreachReadRepository {
  constructor(private readonly db: DbExecutor) {}

  async insertCampaign(c: {
    name: string;
    sequencePolicy: unknown;
    timezone: string;
  }): Promise<OutreachCampaign> {
    const now = new Date();
    const id = randomUUID();
    await this.db.insert(outreachCampaigns).values({
      id,
      name: c.name,
      sequencePolicy: c.sequencePolicy,
      timezone: c.timezone,
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    });
    return { id, name: c.name, sequencePolicy: c.sequencePolicy, timezone: c.timezone, status: 'ACTIVE', createdAt: now, updatedAt: now };
  }

  async getCampaignByName(name: string): Promise<OutreachCampaign | null> {
    const rows = await this.db.select().from(outreachCampaigns).where(eq(outreachCampaigns.name, name)).limit(1);
    const r = rows[0];
    return r ? { ...r, status: r.status as OutreachCampaign['status'] } : null;
  }

  async getRecordById(id: string): Promise<OutreachRecord | null> {
    const rows = await this.db.select().from(outreachRecords).where(eq(outreachRecords.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async timeline(recordId: string): Promise<OutreachEvent[]> {
    const rows = await this.db
      .select()
      .from(outreachEvents)
      .where(eq(outreachEvents.outreachRecordId, recordId))
      .orderBy(asc(outreachEvents.seq));
    return rows.map((r) => ({
      id: r.id,
      outreachRecordId: r.outreachRecordId,
      seq: r.seq,
      type: r.type as OutreachEvent['type'],
      fromStatus: r.fromStatus,
      toStatus: r.toStatus,
      message: r.message,
      data: r.data,
      createdAt: r.createdAt,
    }));
  }

  async messagesForRecord(recordId: string): Promise<OutreachMessage[]> {
    const rows = await this.db
      .select()
      .from(outreachMessages)
      .where(eq(outreachMessages.outreachRecordId, recordId))
      .orderBy(asc(outreachMessages.createdAt));
    return rows.map((r) => ({
      id: r.id,
      outreachRecordId: r.outreachRecordId,
      messageType: r.messageType as OutreachMessage['messageType'],
      sequenceStep: r.sequenceStep,
      subject: r.subject,
      body: r.body,
      contentHash: r.contentHash,
      emailDraftId: r.emailDraftId,
      finalizedEmailId: r.finalizedEmailId,
      gmailMessageId: r.gmailMessageId,
      gmailThreadId: r.gmailThreadId,
      approvedAt: r.approvedAt,
      sentAt: r.sentAt,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Threads to check during reply sync: records that have at least one outbound message. An
   * optional filter narrows to a single record or a single campaign (read-only; the live reader
   * only ever receives thread ids drawn from this tracked set — never a mailbox-wide list).
   */
  async trackedThreads(filter?: { recordId?: string; campaignId?: string }): Promise<TrackedThread[]> {
    const conditions = [
      sql`${outreachMessages.gmailThreadId} IS NOT NULL AND ${outreachMessages.sentAt} IS NOT NULL`,
    ];
    if (filter?.recordId) conditions.push(eq(outreachMessages.outreachRecordId, filter.recordId));
    if (filter?.campaignId) conditions.push(eq(outreachRecords.campaignId, filter.campaignId));

    const msgRows = await this.db
      .select({
        recordId: outreachMessages.outreachRecordId,
        threadId: outreachMessages.gmailThreadId,
        sentAt: outreachMessages.sentAt,
      })
      .from(outreachMessages)
      .innerJoin(outreachRecords, eq(outreachRecords.id, outreachMessages.outreachRecordId))
      .where(and(...conditions));

    const byRecord = new Map<string, { threadId: string; lastOutboundAtMs: number }>();
    for (const m of msgRows) {
      if (!m.threadId || !m.sentAt) continue;
      const cur = byRecord.get(m.recordId);
      const at = m.sentAt.getTime();
      if (!cur || at > cur.lastOutboundAtMs) byRecord.set(m.recordId, { threadId: m.threadId, lastOutboundAtMs: at });
    }
    const recordIds = [...byRecord.keys()];
    const handled = new Map<string, string[]>();
    if (recordIds.length > 0) {
      const replyRows = await this.db
        .select({ recordId: outreachReplies.outreachRecordId, messageId: outreachReplies.gmailMessageId })
        .from(outreachReplies)
        .where(inArray(outreachReplies.outreachRecordId, recordIds));
      for (const r of replyRows) {
        const arr = handled.get(r.recordId) ?? [];
        arr.push(r.messageId);
        handled.set(r.recordId, arr);
      }
    }
    return [...byRecord.entries()].map(([recordId, v]) => ({
      outreachRecordId: recordId,
      threadId: v.threadId,
      lastOutboundAtMs: v.lastOutboundAtMs,
      handledMessageIds: handled.get(recordId) ?? [],
    }));
  }

  /**
   * Tracked outbound messages that a delivery reconciliation should correlate DSNs against
   * (Phase 17C). Each row is one SENT message that carries a Gmail message id. A `recordId`
   * filter includes that record regardless of status (explicit operator re-check); the
   * unscoped/`campaignId` forms return only UNRESOLVED records (not already BOUNCED or in a
   * terminal state), so re-running "all" after a bounce naturally finds nothing new.
   */
  async trackedOutbounds(filter?: { recordId?: string; campaignId?: string }): Promise<TrackedOutbound[]> {
    const conditions = [
      sql`${outreachMessages.gmailMessageId} IS NOT NULL AND ${outreachMessages.sentAt} IS NOT NULL`,
    ];
    if (filter?.recordId) {
      conditions.push(eq(outreachMessages.outreachRecordId, filter.recordId));
    } else {
      // "All eligible unresolved sent records": exclude already-resolved terminal states.
      conditions.push(sql`${outreachRecords.status} NOT IN ('BOUNCED','UNSUBSCRIBED','DO_NOT_CONTACT','CLOSED_WON','CLOSED_LOST')`);
      if (filter?.campaignId) conditions.push(eq(outreachRecords.campaignId, filter.campaignId));
    }

    const rows = await this.db
      .select({
        recordId: outreachMessages.outreachRecordId,
        messageId: outreachMessages.id,
        gmailMessageId: outreachMessages.gmailMessageId,
        gmailThreadId: outreachMessages.gmailThreadId,
        contactEmail: outreachRecords.contactEmail,
      })
      .from(outreachMessages)
      .innerJoin(outreachRecords, eq(outreachRecords.id, outreachMessages.outreachRecordId))
      .where(and(...conditions));

    const out: TrackedOutbound[] = [];
    for (const r of rows) {
      if (!r.gmailMessageId) continue;
      out.push({
        outreachRecordId: r.recordId,
        outreachMessageId: r.messageId,
        gmailMessageId: r.gmailMessageId,
        gmailThreadId: r.gmailThreadId ?? '',
        contactEmail: r.contactEmail,
        rfcMessageId: null,
      });
    }
    return out;
  }

  /** Delivery/bounce events for a record, oldest-first (Phase 17C; shown in the timeline). */
  async deliveryEventsForRecord(recordId: string): Promise<OutreachDeliveryEvent[]> {
    const rows = await this.db
      .select()
      .from(outreachDeliveryEvents)
      .where(eq(outreachDeliveryEvents.outreachRecordId, recordId))
      .orderBy(asc(outreachDeliveryEvents.createdAt));
    return rows.map((r) => ({
      id: r.id,
      outreachRecordId: r.outreachRecordId,
      outreachMessageId: r.outreachMessageId,
      deliveryStatus: r.deliveryStatus as OutreachDeliveryEvent['deliveryStatus'],
      permanence: r.permanence as OutreachDeliveryEvent['permanence'],
      rejectionCode: r.rejectionCode,
      diagnosticText: r.diagnosticText,
      dsnStatus: r.dsnStatus,
      dsnAction: r.dsnAction,
      finalRecipient: r.finalRecipient,
      originalRecipient: r.originalRecipient,
      bounceAt: r.bounceAt,
      originalGmailMessageId: r.originalGmailMessageId,
      originalGmailThreadId: r.originalGmailThreadId,
      dsnGmailMessageId: r.dsnGmailMessageId,
      dsnGmailThreadId: r.dsnGmailThreadId,
      preview: r.preview,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Full projection for the Google Sheet. An optional `campaignId` narrows every tab to a single
   * campaign (used by a SCOPED, upsert-only Sheet sync); omitting it projects all outreach. This is
   * read-only and never mutates anything.
   */
  async projection(filter?: { campaignId?: string }): Promise<OutreachProjection> {
    const campaignId = filter?.campaignId;
    const recWhere = campaignId ? eq(outreachRecords.campaignId, campaignId) : undefined;

    const recRows = await this.db
      .select({
        r: outreachRecords,
        business: leads.businessName,
        domain: leads.normalizedDomain,
        campaign: outreachCampaigns.name,
      })
      .from(outreachRecords)
      .innerJoin(leads, eq(leads.id, outreachRecords.leadId))
      .innerJoin(outreachCampaigns, eq(outreachCampaigns.id, outreachRecords.campaignId))
      .where(recWhere)
      .orderBy(asc(outreachRecords.createdAt));

    const leadIds = [...new Set(recRows.map((x) => x.r.leadId))];
    const scoreByLead = await this.latestScores(leadIds);
    const demoByLead = await this.latestDemoUrls(leadIds);

    const outreach: OutreachRowView[] = recRows.map((x) => ({
      recordId: x.r.id,
      business: x.business,
      domain: x.domain,
      contactEmail: x.r.contactEmail,
      campaign: x.campaign,
      qualificationScore: scoreByLead.get(x.r.leadId) ?? null,
      demoUrl: demoByLead.get(x.r.leadId) ?? null,
      status: x.r.status,
      sequenceStep: x.r.sequenceStep,
      lastSentAt: x.r.lastSentAt,
      nextFollowupAt: x.r.nextFollowupAt,
      lastReplyAt: x.r.lastReplyAt,
      replyCategory: x.r.replyCategory,
      doNotContact: x.r.doNotContact,
      owner: x.r.owner,
      outcome: x.r.outcome,
      notes: x.r.notes,
    }));

    const msgRows = await this.db
      .select({
        m: outreachMessages,
        business: leads.businessName,
        contactEmail: outreachRecords.contactEmail,
        campaign: outreachCampaigns.name,
      })
      .from(outreachMessages)
      .innerJoin(outreachRecords, eq(outreachRecords.id, outreachMessages.outreachRecordId))
      .innerJoin(leads, eq(leads.id, outreachRecords.leadId))
      .innerJoin(outreachCampaigns, eq(outreachCampaigns.id, outreachRecords.campaignId))
      .where(recWhere)
      .orderBy(asc(outreachMessages.createdAt));
    const messages: MessageRowView[] = msgRows.map((x) => ({
      messageId: x.m.id,
      business: x.business,
      contactEmail: x.contactEmail,
      campaign: x.campaign,
      messageType: x.m.messageType,
      sequenceStep: x.m.sequenceStep,
      subject: x.m.subject,
      contentHash: x.m.contentHash,
      approvedAt: x.m.approvedAt,
      sentAt: x.m.sentAt,
      gmailMessageId: x.m.gmailMessageId,
      gmailThreadId: x.m.gmailThreadId,
    }));

    const fuRows = await this.db
      .select({
        f: outreachFollowups,
        business: leads.businessName,
        contactEmail: outreachRecords.contactEmail,
        status: outreachRecords.status,
        lastReplyAt: outreachRecords.lastReplyAt,
      })
      .from(outreachFollowups)
      .innerJoin(outreachRecords, eq(outreachRecords.id, outreachFollowups.outreachRecordId))
      .innerJoin(leads, eq(leads.id, outreachRecords.leadId))
      .where(campaignId ? and(eq(outreachFollowups.status, 'DUE'), eq(outreachRecords.campaignId, campaignId)) : eq(outreachFollowups.status, 'DUE'))
      .orderBy(asc(outreachFollowups.dueAt));
    const followupsDue: FollowupRowView[] = fuRows.map((x) => ({
      followupId: x.f.id,
      business: x.business,
      contactEmail: x.contactEmail,
      step: x.f.step,
      dueAt: x.f.dueAt,
      replyDetected: x.lastReplyAt !== null,
      blockedReason: x.f.blockedReason,
      humanApprovalStatus: 'PENDING_HUMAN_APPROVAL',
    }));

    const repRows = await this.db
      .select({
        rep: outreachReplies,
        business: leads.businessName,
        outcome: outreachRecords.outcome,
        status: outreachRecords.status,
        notes: outreachRecords.notes,
      })
      .from(outreachReplies)
      .innerJoin(outreachRecords, eq(outreachRecords.id, outreachReplies.outreachRecordId))
      .innerJoin(leads, eq(leads.id, outreachRecords.leadId))
      .where(recWhere)
      .orderBy(asc(outreachReplies.receivedAt));
    const replies: ReplyRowView[] = repRows.map((x) => ({
      replyId: x.rep.id,
      business: x.business,
      gmailThreadId: x.rep.gmailThreadId,
      receivedAt: x.rep.receivedAt,
      classification: x.rep.classification,
      summary: x.rep.preview,
      meetingStatus: x.status === 'MEETING_BOOKED' ? 'BOOKED' : 'none',
      outcome: x.outcome,
      notes: x.notes,
    }));

    return { outreach, messages, followupsDue, replies };
  }

  private async latestScores(leadIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (leadIds.length === 0) return out;
    const rows = await this.db
      .select({
        leadId: qualificationResults.leadId,
        score: qualificationResults.deterministicScore,
        at: qualificationResults.evaluatedAt,
      })
      .from(qualificationResults)
      .where(inArray(qualificationResults.leadId, leadIds))
      .orderBy(desc(qualificationResults.evaluatedAt));
    for (const r of rows) {
      if (!out.has(r.leadId) && r.score !== null) out.set(r.leadId, r.score);
    }
    return out;
  }

  private async latestDemoUrls(leadIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (leadIds.length === 0) return out;
    const rows = await this.db
      .select({
        leadId: demoDeploymentRuns.leadId,
        url: demoDeploymentRuns.verifiedUrl,
        at: demoDeploymentRuns.completedAt,
      })
      .from(demoDeploymentRuns)
      .where(
        and(
          inArray(demoDeploymentRuns.leadId, leadIds),
          eq(demoDeploymentRuns.outcome, 'DEPLOYED_AND_VERIFIED'),
        ),
      )
      .orderBy(desc(demoDeploymentRuns.completedAt));
    for (const r of rows) {
      if (!out.has(r.leadId) && r.url !== null) out.set(r.leadId, r.url);
    }
    return out;
  }
}
