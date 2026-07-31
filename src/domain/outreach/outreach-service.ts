import { randomUUID } from 'node:crypto';
import { AppError } from '../../utils/errors.js';
import { type DeliveryPermanence, type DeliveryStatus } from './delivery.js';
import { type NewOutreachEvent } from './events.js';
import {
  computeFollowupDueUtc,
  followupBlockedReason,
  type FollowupStep,
  type SequencePolicy,
} from './followups.js';
import {
  classificationToStatus,
  type ReplyClassification,
  safePreview,
} from './reply-classification.js';
import {
  messageContentHash,
  type OutreachDeliveryEvent,
  type OutreachFollowup,
  type OutreachMessage,
  type OutreachMessageType,
  type OutreachRecord,
} from './records.js';
import { assertOutreachTransition, canOutreachTransition, cancelsFollowups } from './state-machine.js';
import { OUTREACH_SEND_BLOCKED, type OutreachStatus } from './status.js';

export type { OutreachRecord } from './records.js';

/**
 * Write ports, all invoked inside a single transaction. The Drizzle unit of work
 * and the in-memory test store both implement this. `appendEvent` assigns and
 * returns the next per-record sequence number so the timeline stays strictly ordered.
 */
export interface OutreachTxRepos {
  getRecord(id: string): Promise<OutreachRecord | null>;
  findActiveRecord(
    campaignId: string,
    leadId: string,
    contactEmail: string,
  ): Promise<OutreachRecord | null>;
  /** True if this contact is do-not-contact / unsubscribed in ANY campaign. */
  hasDoNotContact(contactEmail: string): Promise<boolean>;
  insertRecord(rec: OutreachRecord): Promise<void>;
  updateRecord(id: string, patch: Partial<OutreachRecord>, now: Date): Promise<void>;
  insertMessage(msg: OutreachMessage): Promise<void>;
  insertReply(reply: {
    id: string;
    outreachRecordId: string;
    gmailThreadId: string;
    gmailMessageId: string;
    fromEmail: string;
    receivedAt: Date;
    classification: string;
    preview: string;
  }): Promise<void>;
  insertFollowup(f: OutreachFollowup): Promise<void>;
  updateFollowupStatus(
    id: string,
    status: OutreachFollowup['status'],
    reason: string | null,
    now: Date,
  ): Promise<void>;
  pendingFollowups(recordId: string): Promise<OutreachFollowup[]>;
  appendEvent(evt: NewOutreachEvent): Promise<number>;
  /** True if a delivery event for this DSN Gmail message id already exists (idempotency). */
  deliveryEventExists(dsnGmailMessageId: string): Promise<boolean>;
  insertDeliveryEvent(evt: OutreachDeliveryEvent): Promise<void>;
  /** Look up delivery events by their DSN Gmail message ids (Phase 17C1 correction). */
  deliveryEventsByDsnIds(dsnGmailMessageIds: string[]): Promise<DeliveryEventRef[]>;
  /** Invalidate (supersede) a delivery event without deleting it (Phase 17C1 correction). */
  supersedeDeliveryEvent(id: string, supersededAt: Date, reason: string, by: string): Promise<void>;
}

/** Minimal delivery-event shape used by the operator correction path. */
export interface DeliveryEventRef {
  id: string;
  dsnGmailMessageId: string;
  outreachRecordId: string;
  deliveryStatus: string;
  supersededAt: Date | null;
}

export interface OutreachUnitOfWork {
  transaction<T>(fn: (repos: OutreachTxRepos) => Promise<T>): Promise<T>;
}

export interface TrackInput {
  campaignId: string;
  leadId: string;
  contactEmail: string;
  timezone: string;
  owner?: string | null;
}

export type TrackOutcome = 'CREATED' | 'DUPLICATE_ACTIVE' | 'BLOCKED_DO_NOT_CONTACT';

export interface TrackResult {
  outcome: TrackOutcome;
  record: OutreachRecord | null;
}

export interface RecordMessageInput {
  outreachRecordId: string;
  messageType: OutreachMessageType;
  sequenceStep: number;
  subject: string;
  body: string;
  emailDraftId?: string | null;
  finalizedEmailId?: string | null;
  gmailMessageId?: string | null;
  gmailThreadId?: string | null;
  approvedAt?: Date | null;
  sentAt?: Date | null;
}

export interface ApplyReplyInput {
  outreachRecordId: string;
  gmailThreadId: string;
  gmailMessageId: string;
  fromEmail: string;
  receivedAtMs: number;
  preview: string;
  classification: ReplyClassification;
}

/** Input for {@link OutreachService.applyDeliveryFailure} (Phase 17C). */
export interface ApplyDeliveryFailureInput {
  outreachRecordId: string;
  outreachMessageId: string | null;
  /** BOUNCED for a permanent failure; DELIVERY_UNKNOWN for a temporary one. */
  deliveryStatus: DeliveryStatus;
  permanence: DeliveryPermanence;
  rejectionCode: string | null;
  diagnosticText: string | null;
  dsnStatus: string | null;
  dsnAction: string | null;
  finalRecipient: string | null;
  originalRecipient: string | null;
  bounceAtMs: number | null;
  originalGmailMessageId: string | null;
  originalGmailThreadId: string | null;
  dsnGmailMessageId: string;
  dsnGmailThreadId: string | null;
  preview: string;
}

export type DeliveryFailureOutcome =
  /** A permanent bounce was applied: record → BOUNCED, pending follow-ups cancelled. */
  | 'BOUNCED_APPLIED'
  /** The record is already in a terminal/resolved state; NO delivery event was written. */
  | 'SKIPPED_TERMINAL'
  /** A temporary failure was recorded for operator review; the record state is unchanged. */
  | 'DELIVERY_UNKNOWN_RECORDED'
  /** This exact DSN was already reconciled; nothing changed (idempotent). */
  | 'ALREADY_RECONCILED';

export interface DeliveryFailureResult {
  outcome: DeliveryFailureOutcome;
  record: OutreachRecord;
}

/** Input for the Phase 17C1 operator correction of mis-correlated delivery events. */
export interface CorrectDeliveryEventsInput {
  dsnGmailMessageIds: string[];
  reason: string;
  by: string;
  dryRun: boolean;
}

export interface DeliveryEventCorrectionView {
  dsnGmailMessageId: string;
  found: boolean;
  outreachRecordId: string | null;
  deliveryStatus: string | null;
  alreadySuperseded: boolean;
}

export interface CorrectDeliveryEventsResult {
  dryRun: boolean;
  applied: boolean;
  events: DeliveryEventCorrectionView[];
  /** Delivery events that would be / were invalidated (excludes already-superseded). */
  toSupersedeCount: number;
  alreadySupersededCount: number;
  notFound: string[];
  /** Records whose timeline got a DELIVERY_RECONCILIATION_CORRECTED event (apply only). */
  recordsAnnotated: string[];
}

/**
 * Phase 17A outreach tracking service. Owns state transitions, immutable message
 * history, follow-up scheduling/cancellation, and reply application. It performs NO
 * external effect: it never sends email, never calls Gmail, never writes a Sheet.
 * All effects go through injected ports and a deterministic, injected clock.
 */
export class OutreachService {
  private readonly now: () => number;
  constructor(
    private readonly uow: OutreachUnitOfWork,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * Create a tracked outreach record for (campaign, lead, contact). Fails closed on
   * do-not-contact and refuses a second ACTIVE record for the same tuple (the DB
   * partial-unique index is the ultimate guarantee; this is the friendly check).
   */
  async track(input: TrackInput): Promise<TrackResult> {
    const contactEmail = input.contactEmail.trim().toLowerCase();
    return this.uow.transaction(async (repos) => {
      if (await repos.hasDoNotContact(contactEmail)) {
        return { outcome: 'BLOCKED_DO_NOT_CONTACT', record: null };
      }
      const existing = await repos.findActiveRecord(input.campaignId, input.leadId, contactEmail);
      if (existing) return { outcome: 'DUPLICATE_ACTIVE', record: existing };

      const nowD = new Date(this.now());
      const record: OutreachRecord = {
        id: randomUUID(),
        campaignId: input.campaignId,
        leadId: input.leadId,
        contactEmail,
        status: 'DRAFT_READY',
        sequenceStep: 0,
        owner: input.owner ?? null,
        timezone: input.timezone,
        lastSentAt: null,
        nextFollowupAt: null,
        lastReplyAt: null,
        replyCategory: null,
        doNotContact: false,
        outcome: null,
        notes: null,
        createdAt: nowD,
        updatedAt: nowD,
      };
      await repos.insertRecord(record);
      await repos.appendEvent({
        outreachRecordId: record.id,
        type: 'RECORD_CREATED',
        fromStatus: null,
        toStatus: 'DRAFT_READY',
        message: `Outreach created for ${contactEmail}`,
        data: { campaignId: input.campaignId, leadId: input.leadId },
      });
      return { outcome: 'CREATED', record };
    });
  }

  /**
   * Transition an outreach record. Invalid transitions are rejected with a typed
   * error and leave the record completely unchanged (the whole transaction rolls
   * back, so no partial write or event survives). If the destination cancels the
   * sequence (any reply/bounce/unsubscribe/DNC/meeting/closed), every pending
   * follow-up is cancelled atomically in the same transaction.
   */
  async transition(
    recordId: string,
    to: OutreachStatus,
    opts: { reason?: string; setOutcome?: boolean } = {},
  ): Promise<OutreachRecord> {
    return this.uow.transaction(async (repos) => {
      const rec = await this.require(repos, recordId);
      const from = rec.status;
      // Reject before any mutation: nothing is written for an illegal transition.
      assertOutreachTransition(from, to);
      const nowD = new Date(this.now());
      const patch: Partial<OutreachRecord> = { status: to };
      if (to === 'DO_NOT_CONTACT' || to === 'UNSUBSCRIBED') patch.doNotContact = true;
      if (opts.setOutcome && (to === 'MEETING_BOOKED' || to === 'CLOSED_WON' || to === 'CLOSED_LOST')) {
        patch.outcome = to;
      }
      if (cancelsFollowups(to)) patch.nextFollowupAt = null;

      await repos.updateRecord(recordId, patch, nowD);
      await repos.appendEvent({
        outreachRecordId: recordId,
        type: 'STATE_TRANSITION',
        fromStatus: from,
        toStatus: to,
        message: `${from} -> ${to}${opts.reason ? ` (${opts.reason})` : ''}`,
        data: opts.reason ? { reason: opts.reason } : null,
      });
      if (cancelsFollowups(to)) {
        await this.cancelPending(repos, recordId, followupBlockedReason(to) ?? 'CANCELLED', nowD);
      }
      return { ...rec, ...patch, updatedAt: nowD };
    });
  }

  /**
   * Append an immutable message snapshot (exact subject + body + hash). For a SENT
   * message the record's lastSentAt and sequenceStep advance. Message rows are never
   * updated or deleted after insert — this is the exact outreach history.
   */
  async recordMessage(input: RecordMessageInput): Promise<OutreachMessage> {
    return this.uow.transaction(async (repos) => {
      await this.require(repos, input.outreachRecordId);
      const nowD = new Date(this.now());
      const msg: OutreachMessage = {
        id: randomUUID(),
        outreachRecordId: input.outreachRecordId,
        messageType: input.messageType,
        sequenceStep: input.sequenceStep,
        subject: input.subject,
        body: input.body,
        contentHash: messageContentHash(input.subject, input.body),
        emailDraftId: input.emailDraftId ?? null,
        finalizedEmailId: input.finalizedEmailId ?? null,
        gmailMessageId: input.gmailMessageId ?? null,
        gmailThreadId: input.gmailThreadId ?? null,
        approvedAt: input.approvedAt ?? null,
        sentAt: input.sentAt ?? null,
        createdAt: nowD,
      };
      await repos.insertMessage(msg);
      if (msg.sentAt) {
        await repos.updateRecord(
          input.outreachRecordId,
          { lastSentAt: msg.sentAt, sequenceStep: input.sequenceStep },
          nowD,
        );
      }
      await repos.appendEvent({
        outreachRecordId: input.outreachRecordId,
        type: 'MESSAGE_RECORDED',
        fromStatus: null,
        toStatus: null,
        message: `${input.messageType} step ${String(input.sequenceStep)} recorded`,
        data: { contentHash: msg.contentHash, gmailMessageId: msg.gmailMessageId },
      });
      return msg;
    });
  }

  /**
   * Schedule a follow-up due date (calculation + persistence only — never sends).
   * Refuses when the record's status forbids follow-ups (reply/bounce/unsubscribe/
   * DNC/meeting/closed).
   */
  async scheduleFollowup(
    recordId: string,
    step: FollowupStep,
    policy: SequencePolicy,
  ): Promise<{ outcome: 'SCHEDULED' | 'BLOCKED'; followup: OutreachFollowup | null; reason?: string }> {
    return this.uow.transaction(async (repos) => {
      const rec = await this.require(repos, recordId);
      const blocked = followupBlockedReason(rec.status);
      if (blocked) return { outcome: 'BLOCKED', followup: null, reason: blocked };
      if (rec.lastSentAt === null) {
        return { outcome: 'BLOCKED', followup: null, reason: 'NO_PRIOR_SEND' };
      }
      const nowD = new Date(this.now());
      const dueAt = computeFollowupDueUtc({
        previousSentAtMs: rec.lastSentAt.getTime(),
        step,
        timezone: rec.timezone,
        policy,
      });
      const followup: OutreachFollowup = {
        id: randomUUID(),
        outreachRecordId: recordId,
        step,
        dueAt,
        timezone: rec.timezone,
        status: 'DUE',
        blockedReason: null,
        cancelledReason: null,
        createdAt: nowD,
        updatedAt: nowD,
      };
      await repos.insertFollowup(followup);
      await repos.updateRecord(recordId, { nextFollowupAt: dueAt }, nowD);
      await repos.appendEvent({
        outreachRecordId: recordId,
        type: 'FOLLOWUP_SCHEDULED',
        fromStatus: null,
        toStatus: null,
        message: `Follow-up ${String(step)} due ${dueAt.toISOString()}`,
        data: { step, dueAt: dueAt.toISOString() },
      });
      return { outcome: 'SCHEDULED', followup };
    });
  }

  /** Operator cancels a single pending follow-up. Immutable event recorded. */
  async cancelFollowup(followupId: string, recordId: string, reason: string): Promise<void> {
    await this.uow.transaction(async (repos) => {
      const nowD = new Date(this.now());
      await repos.updateFollowupStatus(followupId, 'CANCELLED', reason, nowD);
      await repos.updateRecord(recordId, { nextFollowupAt: null }, nowD);
      await repos.appendEvent({
        outreachRecordId: recordId,
        type: 'FOLLOWUP_CANCELLED',
        fromStatus: null,
        toStatus: null,
        message: `Follow-up cancelled: ${reason}`,
        data: { followupId, reason },
      });
    });
  }

  /** Operator postpones a follow-up to a new explicit due instant. */
  async postponeFollowup(
    followupId: string,
    recordId: string,
    newDueAt: Date,
    reason: string,
  ): Promise<void> {
    await this.uow.transaction(async (repos) => {
      const nowD = new Date(this.now());
      await repos.updateFollowupStatus(followupId, 'POSTPONED', reason, nowD);
      await repos.updateRecord(recordId, { nextFollowupAt: newDueAt }, nowD);
      await repos.appendEvent({
        outreachRecordId: recordId,
        type: 'FOLLOWUP_POSTPONED',
        fromStatus: null,
        toStatus: null,
        message: `Follow-up postponed to ${newDueAt.toISOString()}: ${reason}`,
        data: { followupId, newDueAt: newDueAt.toISOString(), reason },
      });
    });
  }

  /**
   * Apply a detected inbound reply: persist the reply row, transition to the driven
   * status (positive/neutral/negative/bounce/unsubscribe), set reply metadata, and
   * cancel every pending follow-up. Unsubscribe additionally sets do-not-contact.
   */
  async applyReply(input: ApplyReplyInput): Promise<OutreachRecord> {
    return this.uow.transaction(async (repos) => {
      const rec = await this.require(repos, input.outreachRecordId);
      const to = classificationToStatus(input.classification);
      const nowD = new Date(this.now());
      const receivedAt = new Date(input.receivedAtMs);

      await repos.insertReply({
        id: randomUUID(),
        outreachRecordId: input.outreachRecordId,
        gmailThreadId: input.gmailThreadId,
        gmailMessageId: input.gmailMessageId,
        fromEmail: input.fromEmail.trim().toLowerCase(),
        receivedAt,
        classification: input.classification,
        preview: safePreview(input.preview),
      });

      const patch: Partial<OutreachRecord> = {
        status: to,
        lastReplyAt: receivedAt,
        replyCategory: input.classification,
        nextFollowupAt: null,
      };
      if (to === 'UNSUBSCRIBED') patch.doNotContact = true;

      // Record the transition (validate; a reply/bounce/unsub is legal from any
      // non-terminal state). If the record is already terminal, we still persist the
      // reply row but do not force an illegal transition.
      const legal = (() => {
        try {
          assertOutreachTransition(rec.status, to);
          return true;
        } catch {
          return false;
        }
      })();

      if (legal) {
        await repos.updateRecord(input.outreachRecordId, patch, nowD);
        await repos.appendEvent({
          outreachRecordId: input.outreachRecordId,
          type: 'STATE_TRANSITION',
          fromStatus: rec.status,
          toStatus: to,
          message: `${rec.status} -> ${to} (reply)`,
          data: { classification: input.classification },
        });
      } else {
        // Terminal already: keep status, but still record reply metadata + event.
        await repos.updateRecord(
          input.outreachRecordId,
          { lastReplyAt: receivedAt, replyCategory: input.classification },
          nowD,
        );
      }
      await repos.appendEvent({
        outreachRecordId: input.outreachRecordId,
        type: 'REPLY_DETECTED',
        fromStatus: null,
        toStatus: null,
        message: `Reply from ${input.fromEmail} classified ${input.classification}`,
        data: { gmailMessageId: input.gmailMessageId, classification: input.classification },
      });
      await this.cancelPending(repos, input.outreachRecordId, 'REPLY_DETECTED', nowD);
      return { ...rec, ...patch, updatedAt: nowD };
    });
  }

  /**
   * Apply a correlated delivery failure (Phase 17C). Deterministic and idempotent:
   *
   *  - Idempotent by the DSN's Gmail message id: a DSN already reconciled makes no change.
   *  - A PERMANENT failure (deliveryStatus BOUNCED) transitions the record to BOUNCED
   *    (when legal), cancels EVERY pending follow-up, and appends immutable
   *    BOUNCE_DETECTED + FOLLOWUPS_CANCELLED events. The original INITIAL_SENT event and
   *    sent timestamp are preserved (the message row is never touched). It does NOT set
   *    do-not-contact and NEVER schedules a retry.
   *  - A TEMPORARY failure (deliveryStatus DELIVERY_UNKNOWN) records the diagnostic and a
   *    DELIVERY_UNKNOWN event for operator review, but changes no state and never retries.
   *
   * A delivery-event row is always inserted (the auditable diagnostic), whatever the outcome.
   */
  async applyDeliveryFailure(input: ApplyDeliveryFailureInput): Promise<DeliveryFailureResult> {
    return this.uow.transaction(async (repos) => {
      const rec = await this.require(repos, input.outreachRecordId);
      const nowD = new Date(this.now());

      // Idempotency: this exact DSN was already reconciled — change nothing.
      if (await repos.deliveryEventExists(input.dsnGmailMessageId)) {
        return { outcome: 'ALREADY_RECONCILED', record: rec };
      }

      // Terminal/resolved records (already BOUNCED, unsubscribed, DNC, or closed) are left
      // exactly as they are — NO new delivery event is written. A record correctly resolved
      // by another path (e.g. reply-sync) must not accrue late, duplicate delivery events.
      if (OUTREACH_SEND_BLOCKED.includes(rec.status)) {
        return { outcome: 'SKIPPED_TERMINAL', record: rec };
      }

      await repos.insertDeliveryEvent({
        id: randomUUID(),
        outreachRecordId: input.outreachRecordId,
        outreachMessageId: input.outreachMessageId,
        deliveryStatus: input.deliveryStatus,
        permanence: input.permanence,
        rejectionCode: input.rejectionCode,
        diagnosticText: input.diagnosticText ? safePreview(input.diagnosticText, 500) : null,
        dsnStatus: input.dsnStatus,
        dsnAction: input.dsnAction,
        finalRecipient: input.finalRecipient,
        originalRecipient: input.originalRecipient,
        bounceAt: input.bounceAtMs !== null ? new Date(input.bounceAtMs) : null,
        originalGmailMessageId: input.originalGmailMessageId,
        originalGmailThreadId: input.originalGmailThreadId,
        dsnGmailMessageId: input.dsnGmailMessageId,
        dsnGmailThreadId: input.dsnGmailThreadId,
        preview: safePreview(input.preview),
        supersededAt: null,
        supersededReason: null,
        supersededBy: null,
        createdAt: nowD,
      });

      // Temporary / undetermined failure: record for operator review, change no state.
      if (input.deliveryStatus !== 'BOUNCED') {
        await repos.appendEvent({
          outreachRecordId: input.outreachRecordId,
          type: 'DELIVERY_UNKNOWN',
          fromStatus: null,
          toStatus: null,
          message: `Temporary delivery failure (${input.rejectionCode ?? 'no code'}) — operator review required; no retry`,
          data: { dsnGmailMessageId: input.dsnGmailMessageId, status: input.dsnStatus, action: input.dsnAction },
        });
        return { outcome: 'DELIVERY_UNKNOWN_RECORDED', record: rec };
      }

      // Permanent bounce on a non-terminal record (terminal records were skipped above).
      const blockedReason = 'BOUNCED';
      const legal = canOutreachTransition(rec.status, 'BOUNCED');
      const patch: Partial<OutreachRecord> = { nextFollowupAt: null };
      if (legal) patch.status = 'BOUNCED';

      await repos.updateRecord(input.outreachRecordId, patch, nowD);
      await repos.appendEvent({
        outreachRecordId: input.outreachRecordId,
        type: 'BOUNCE_DETECTED',
        fromStatus: rec.status,
        toStatus: legal ? 'BOUNCED' : rec.status,
        message: `Permanent delivery failure (${input.rejectionCode ?? 'no code'})${legal ? ` — ${rec.status} -> BOUNCED` : ' — record left in place (transition not legal)'}; no retry`,
        data: { dsnGmailMessageId: input.dsnGmailMessageId, rejectionCode: input.rejectionCode, diagnostic: input.dsnStatus },
      });

      // Cancel EVERY pending follow-up with an explicit blocked reason, then summarize.
      const pending = await repos.pendingFollowups(input.outreachRecordId);
      for (const f of pending) {
        await repos.updateFollowupStatus(f.id, 'CANCELLED', blockedReason, nowD);
      }
      await repos.appendEvent({
        outreachRecordId: input.outreachRecordId,
        type: 'FOLLOWUPS_CANCELLED',
        fromStatus: null,
        toStatus: null,
        message: `${String(pending.length)} pending follow-up(s) cancelled (${blockedReason})`,
        data: { cancelled: pending.map((f) => f.id), reason: blockedReason },
      });

      return { outcome: 'BOUNCED_APPLIED', record: { ...rec, ...patch, updatedAt: nowD } };
    });
  }

  /**
   * Operator correction of mis-correlated delivery events (Phase 17C1). It INVALIDATES
   * (supersedes) the named delivery events — it never deletes immutable history — recording
   * the correction timestamp, reason, and operator identity, and appending one immutable
   * DELIVERY_RECONCILIATION_CORRECTED event per affected record. It changes NO outreach state
   * and touches NO follow-up: a correctly-BOUNCED record stays BOUNCED with its follow-up
   * cancelled. Idempotent — an already-superseded event is left untouched and adds no event.
   * With `dryRun`, it reports the plan and writes nothing.
   */
  async correctDeliveryEvents(input: CorrectDeliveryEventsInput): Promise<CorrectDeliveryEventsResult> {
    const ids = [...new Set(input.dsnGmailMessageIds.map((s) => s.trim()).filter(Boolean))];
    return this.uow.transaction(async (repos) => {
      const rows = await repos.deliveryEventsByDsnIds(ids);
      const byDsn = new Map(rows.map((r) => [r.dsnGmailMessageId, r]));
      const events: DeliveryEventCorrectionView[] = ids.map((id) => {
        const r = byDsn.get(id);
        return {
          dsnGmailMessageId: id,
          found: !!r,
          outreachRecordId: r?.outreachRecordId ?? null,
          deliveryStatus: r?.deliveryStatus ?? null,
          alreadySuperseded: r?.supersededAt != null,
        };
      });
      const notFound = ids.filter((id) => !byDsn.has(id));
      const toSupersede = rows.filter((r) => r.supersededAt === null);
      const alreadySupersededCount = rows.length - toSupersede.length;

      const recordsAnnotated: string[] = [];
      if (!input.dryRun && toSupersede.length > 0) {
        const nowD = new Date(this.now());
        for (const r of toSupersede) {
          await repos.supersedeDeliveryEvent(r.id, nowD, input.reason, input.by);
        }
        const byRecord = new Map<string, string[]>();
        for (const r of toSupersede) {
          const arr = byRecord.get(r.outreachRecordId) ?? [];
          arr.push(r.dsnGmailMessageId);
          byRecord.set(r.outreachRecordId, arr);
        }
        for (const [recordId, dsnIds] of byRecord) {
          await repos.appendEvent({
            outreachRecordId: recordId,
            type: 'DELIVERY_RECONCILIATION_CORRECTED',
            fromStatus: null,
            toStatus: null,
            message: `${String(dsnIds.length)} delivery event(s) invalidated by ${input.by}: ${input.reason}`,
            data: { dsnGmailMessageIds: dsnIds, reason: input.reason, by: input.by },
          });
          recordsAnnotated.push(recordId);
        }
      }

      return {
        dryRun: input.dryRun,
        applied: !input.dryRun && toSupersede.length > 0,
        events,
        toSupersedeCount: toSupersede.length,
        alreadySupersededCount,
        notFound,
        recordsAnnotated,
      };
    });
  }

  private async cancelPending(
    repos: OutreachTxRepos,
    recordId: string,
    reason: string,
    now: Date,
  ): Promise<void> {
    const pending = await repos.pendingFollowups(recordId);
    for (const f of pending) {
      await repos.updateFollowupStatus(f.id, 'CANCELLED', reason, now);
      await repos.appendEvent({
        outreachRecordId: recordId,
        type: 'FOLLOWUP_CANCELLED',
        fromStatus: null,
        toStatus: null,
        message: `Follow-up ${String(f.step)} cancelled (${reason})`,
        data: { followupId: f.id, reason },
      });
    }
  }

  private async require(repos: OutreachTxRepos, recordId: string): Promise<OutreachRecord> {
    const rec = await repos.getRecord(recordId);
    if (!rec) throw new AppError('OUTREACH_RECORD_NOT_FOUND', `Outreach record not found: ${recordId}`);
    return rec;
  }
}
