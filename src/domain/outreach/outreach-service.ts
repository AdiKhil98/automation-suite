import { randomUUID } from 'node:crypto';
import { AppError } from '../../utils/errors.js';
import { type DeliveryPermanence, type DeliveryStatus } from './delivery.js';
import { type NewOutreachEvent } from './events.js';
import {
  decideFollowupPromotion,
  type FollowupPromotionCandidateView,
} from './followup-due-promotion.js';
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
import {
  followupDueStatus,
  followupSentStatus,
  nextFollowupStep,
  pendingFollowupStep,
} from './sequence.js';
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
  /**
   * Compare-and-set update: applies `patch` ONLY while the record is still in `expectedStatus`,
   * and reports whether it matched. This is the serialization point for unattended state changes —
   * two concurrent runs cannot both observe the same "before" status and both write, because the
   * loser's WHERE clause no longer matches once the winner commits.
   */
  updateRecordIfStatus(
    id: string,
    expectedStatus: OutreachStatus,
    patch: Partial<OutreachRecord>,
    now: Date,
  ): Promise<boolean>;
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
  /** One follow-up row by id, re-read inside the transaction (null when it does not exist). */
  getFollowup(id: string): Promise<OutreachFollowup | null>;
  /** Find a stored message by its Gmail message id (enrollment idempotency; null if none). */
  findMessageByGmailMessageId(gmailMessageId: string): Promise<OutreachMessage | null>;
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

/**
 * Input for {@link OutreachService.enrollConfirmedSend} — the production-send -> outreach bridge.
 * The subject/body/Gmail ids are read from the CONFIRMED send records by the caller (never CLI args),
 * so the enrolled message is byte-identical to what was actually sent.
 */
export interface EnrollConfirmedSendInput {
  outreachRecordId: string;
  /** Exact sent subject (from the finalized draft). */
  subject: string;
  /** Exact sent body (from email_draft_finalizations.resolvedBody). */
  body: string;
  /** Gmail identifiers from the confirmed send_attempt. */
  gmailMessageId: string;
  gmailThreadId: string;
  sentAt: Date;
  /** Provenance links back to the email pipeline (optional). */
  emailDraftId?: string | null;
  finalizedEmailId?: string | null;
  /** The confirmed send_attempt id (recorded on the events for provenance). */
  sendAttemptId: string;
  /** Follow-up sequence policy (from config); step 1 is scheduled on enrollment. */
  policy: SequencePolicy;
}

export type EnrollConfirmedSendOutcome =
  /** A new INITIAL step-0 message + INITIAL_SENT transition + follow-up 1 were created. */
  | 'ENROLLED'
  /** This exact Gmail message id is already enrolled; nothing changed (idempotent). */
  | 'ALREADY_ENROLLED'
  /** The record cannot reach INITIAL_SENT (already sent/replied/bounced/terminal); nothing changed. */
  | 'RECORD_NOT_ENROLLABLE';

export interface EnrollConfirmedSendResult {
  outcome: EnrollConfirmedSendOutcome;
  record: OutreachRecord;
  message: OutreachMessage | null;
  followup: OutreachFollowup | null;
}

/**
 * Input for {@link OutreachService.enrollConfirmedFollowup} — the confirmed-FOLLOW-UP -> outreach
 * bridge. Identical in spirit to {@link EnrollConfirmedSendInput}, but for a sequence email that is
 * NOT the first: it updates the EXISTING outreach record instead of creating the initial history.
 */
export interface EnrollConfirmedFollowupInput {
  outreachRecordId: string;
  /**
   * The follow-up step this confirmed send represented, read from DURABLE provenance
   * (`email_drafts.sequence_step` on the attempt's own draft chain) — never guessed from subject
   * text, a timestamp, the current date, or "the latest email". It is cross-checked against the
   * record's own state and the whole enrollment fails closed if the two disagree.
   */
  expectedStep: FollowupStep;
  /** Exact sent subject (from the finalized draft). */
  subject: string;
  /** Exact sent body (from email_draft_finalizations.resolvedBody). */
  body: string;
  /** Gmail identifiers from the confirmed send_attempt. */
  gmailMessageId: string;
  gmailThreadId: string;
  sentAt: Date;
  emailDraftId?: string | null;
  finalizedEmailId?: string | null;
  /** The confirmed send_attempt id (recorded on the events for provenance). */
  sendAttemptId: string;
  /** Follow-up sequence policy (from config); the NEXT step is scheduled from it, when there is one. */
  policy: SequencePolicy;
}

export type EnrollConfirmedFollowupOutcome =
  /** The follow-up message, SENT marking, transition, and the next follow-up (if any) were written. */
  | 'ENROLLED'
  /** This exact Gmail message id is already enrolled; nothing changed (idempotent). */
  | 'ALREADY_ENROLLED'
  /** The record is not waiting on any follow-up (replied/bounced/suppressed/finished); nothing changed. */
  | 'RECORD_NOT_ENROLLABLE'
  /** Durable provenance and record state disagree about the step; nothing changed (fail closed). */
  | 'STEP_MISMATCH';

export interface EnrollConfirmedFollowupResult {
  outcome: EnrollConfirmedFollowupOutcome;
  record: OutreachRecord;
  message: OutreachMessage | null;
  /** The follow-up row that was marked SENT. */
  sentFollowup: OutreachFollowup | null;
  /** The NEXT follow-up that was scheduled, or null after the final step. */
  nextFollowup: OutreachFollowup | null;
  reason?: string;
}

/** The legal approval path an enrolled record is walked through to reach INITIAL_SENT. */
const ENROLL_PATH: readonly OutreachStatus[] = ['DRAFT_READY', 'AWAITING_APPROVAL', 'APPROVED_TO_SEND', 'INITIAL_SENT'];

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

/** Identifies the ONE due follow-up row a promotion attempt is bound to. */
export interface PromoteFollowupDueInput {
  followupId: string;
  outreachRecordId: string;
  /** Recorded on the event so the timeline never implies a human made this transition. */
  actor: string;
}

export interface PromoteFollowupDueResult {
  outcome: PromoteFollowupDueOutcome;
  from: OutreachStatus | null;
  to: OutreachStatus | null;
  detail: string;
}

export type PromoteFollowupDueOutcome =
  /** The record was moved to `FOLLOW_UP_N_DUE` and exactly one event was appended. */
  | 'PROMOTED'
  /** The record already announced this step as due. Nothing was written. */
  | 'ALREADY_DUE'
  /** Suppressed by authoritative state (reply/bounce/unsubscribe/DNC/meeting/closed). */
  | 'BLOCKED'
  /** The row or record did not justify a promotion (not due, inactive, mismatched, missing). */
  | 'SKIPPED'
  /** A concurrent writer changed the record between the re-read and the compare-and-set. */
  | 'RACE_LOST';

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
   * Bridge a CONFIRMED production send (Phase 14/15 `SendService`) into outreach tracking so reply
   * sync, bounce reconciliation, and follow-up scheduling can see it — WITHOUT a second send path.
   * This method NEVER sends: the caller has already dispatched via `SendService` and reads the exact
   * subject/body/Gmail ids from the confirmed `send_attempt`/finalized draft. Everything below is a
   * single atomic transaction:
   *
   *  - Idempotent by the Gmail message id: an already-enrolled send makes no change (`ALREADY_ENROLLED`);
   *    the migration-0037 partial-unique index is the ultimate guarantee, this is the friendly check.
   *  - The record is walked DRAFT_READY -> AWAITING_APPROVAL -> APPROVED_TO_SEND -> INITIAL_SENT through
   *    the state machine (each hop asserted legal); a record already past APPROVED_TO_SEND (or replied/
   *    bounced/terminal) is `RECORD_NOT_ENROLLABLE` and nothing is written.
   *  - One immutable INITIAL step-0 message carries the exact subject/body/hash + Gmail message/thread id
   *    + sent timestamp, `lastSentAt`/`sequenceStep` advance, and follow-up step 1 is scheduled with the
   *    same rules as everywhere else.
   */
  async enrollConfirmedSend(input: EnrollConfirmedSendInput): Promise<EnrollConfirmedSendResult> {
    return this.uow.transaction(async (repos) => {
      const rec = await this.require(repos, input.outreachRecordId);

      // Idempotency: this exact Gmail message id is already enrolled — change nothing.
      const existing = await repos.findMessageByGmailMessageId(input.gmailMessageId);
      if (existing) return { outcome: 'ALREADY_ENROLLED', record: rec, message: existing, followup: null };

      // The record must be able to reach INITIAL_SENT via the approval path. Anything at/after
      // INITIAL_SENT (or replied/bounced/terminal) is not enrollable — never force an illegal jump.
      const startIdx = ENROLL_PATH.indexOf(rec.status);
      if (startIdx < 0 || rec.status === 'INITIAL_SENT') {
        return { outcome: 'RECORD_NOT_ENROLLABLE', record: rec, message: null, followup: null };
      }

      const nowD = new Date(this.now());

      // 1. Immutable INITIAL step-0 message carrying the confirmed send's exact content + Gmail ids.
      const message: OutreachMessage = {
        id: randomUUID(),
        outreachRecordId: rec.id,
        messageType: 'INITIAL',
        sequenceStep: 0,
        subject: input.subject,
        body: input.body,
        contentHash: messageContentHash(input.subject, input.body),
        emailDraftId: input.emailDraftId ?? null,
        finalizedEmailId: input.finalizedEmailId ?? null,
        gmailMessageId: input.gmailMessageId,
        gmailThreadId: input.gmailThreadId,
        approvedAt: nowD,
        sentAt: input.sentAt,
        createdAt: nowD,
      };
      await repos.insertMessage(message);
      await repos.appendEvent({
        outreachRecordId: rec.id,
        type: 'MESSAGE_RECORDED',
        fromStatus: null,
        toStatus: null,
        message: 'INITIAL step 0 enrolled from confirmed production send',
        data: { contentHash: message.contentHash, gmailMessageId: input.gmailMessageId, gmailThreadId: input.gmailThreadId, sendAttemptId: input.sendAttemptId },
      });

      // 2. Walk the record to INITIAL_SENT through the legal approval path (each hop asserted + evented).
      let from: OutreachStatus = rec.status;
      for (let i = startIdx + 1; i < ENROLL_PATH.length; i += 1) {
        const to = ENROLL_PATH[i]!;
        assertOutreachTransition(from, to);
        await repos.appendEvent({
          outreachRecordId: rec.id,
          type: 'STATE_TRANSITION',
          fromStatus: from,
          toStatus: to,
          message: `${from} -> ${to} (enroll confirmed send)`,
          data: { sendAttemptId: input.sendAttemptId },
        });
        from = to;
      }

      // 3. Follow-up step 1, using the existing sequence rules.
      const dueAt = computeFollowupDueUtc({ previousSentAtMs: input.sentAt.getTime(), step: 1, timezone: rec.timezone, policy: input.policy });
      const followup: OutreachFollowup = {
        id: randomUUID(),
        outreachRecordId: rec.id,
        step: 1,
        dueAt,
        timezone: rec.timezone,
        status: 'DUE',
        blockedReason: null,
        cancelledReason: null,
        createdAt: nowD,
        updatedAt: nowD,
      };
      await repos.insertFollowup(followup);

      // Single record update: final status + sent tracking + next follow-up.
      await repos.updateRecord(rec.id, { status: 'INITIAL_SENT', lastSentAt: input.sentAt, sequenceStep: 0, nextFollowupAt: dueAt }, nowD);
      await repos.appendEvent({
        outreachRecordId: rec.id,
        type: 'FOLLOWUP_SCHEDULED',
        fromStatus: null,
        toStatus: null,
        message: `Follow-up 1 due ${dueAt.toISOString()}`,
        data: { step: 1, dueAt: dueAt.toISOString() },
      });

      const record: OutreachRecord = { ...rec, status: 'INITIAL_SENT', lastSentAt: input.sentAt, sequenceStep: 0, nextFollowupAt: dueAt, updatedAt: nowD };
      return { outcome: 'ENROLLED', record, message, followup };
    });
  }

  /**
   * Bridge a CONFIRMED production FOLLOW-UP send into outreach tracking. This is the counterpart to
   * {@link enrollConfirmedSend}, which is deliberately INITIAL-only: that method creates the initial
   * history and refuses a record that is already INITIAL_SENT, so it must never be reused for a
   * follow-up. This one updates the EXISTING record instead.
   *
   * Like the initial bridge it NEVER sends — the caller already dispatched through the production
   * `SendService` and reads the exact subject/body/Gmail ids from the confirmed `send_attempt`.
   * Everything below is ONE atomic transaction, and the whole thing is idempotent:
   *
   *  1. The record is loaded and the Gmail message id is checked first: an already-enrolled message
   *     changes nothing (`ALREADY_ENROLLED`). The migration-0037 partial-unique index on
   *     `outreach_messages.gmail_message_id` remains the hard duplicate backstop underneath.
   *  2. The expected step comes from DURABLE provenance (the caller's `expectedStep`, read from the
   *     attempt's own draft chain) and is cross-checked against the record's state. A record that is
   *     not waiting on any follow-up — replied, bounced, unsubscribed, do-not-contact, meeting
   *     booked, closed, or already finished at FOLLOW_UP_3_SENT — is `RECORD_NOT_ENROLLABLE`, and a
   *     disagreement between provenance and state is `STEP_MISMATCH`. Both write nothing.
   *  3. An immutable FOLLOW_UP message carries the exact subject/body/hash, the finalized email ids,
   *     the Gmail message/thread id, and the sent timestamp.
   *  4. The matching pending follow-up row is marked SENT.
   *  5. The record transitions FOLLOW_UP_n_DUE -> FOLLOW_UP_n_SENT through the state machine.
   *  6. `lastSentAt` and `sequenceStep` advance, and the NEXT follow-up is scheduled — unless this
   *     was the final step (internal 3 / lesson Follow-up #4), after which `nextFollowupAt` is
   *     cleared and NO further sequence email is ever scheduled.
   */
  async enrollConfirmedFollowup(input: EnrollConfirmedFollowupInput): Promise<EnrollConfirmedFollowupResult> {
    return this.uow.transaction(async (repos) => {
      const rec = await this.require(repos, input.outreachRecordId);
      const nothing = (
        outcome: EnrollConfirmedFollowupOutcome,
        reason: string,
      ): EnrollConfirmedFollowupResult => ({ outcome, record: rec, message: null, sentFollowup: null, nextFollowup: null, reason });

      // 1. Idempotency: this exact Gmail message id is already enrolled — change nothing.
      const existing = await repos.findMessageByGmailMessageId(input.gmailMessageId);
      if (existing) {
        return { outcome: 'ALREADY_ENROLLED', record: rec, message: existing, sentFollowup: null, nextFollowup: null };
      }

      // 2. Derive the step the record itself is waiting on, and require provenance to agree.
      const stateStep = pendingFollowupStep(rec.status);
      if (stateStep === null) {
        return nothing('RECORD_NOT_ENROLLABLE', `record status ${rec.status} is not awaiting a follow-up`);
      }
      if (stateStep !== input.expectedStep) {
        return nothing('STEP_MISMATCH', `provenance says step ${String(input.expectedStep)} but the record awaits step ${String(stateStep)}`);
      }
      const step = stateStep;
      const nowD = new Date(this.now());

      // 3. Immutable FOLLOW_UP message carrying the confirmed send's exact content + Gmail ids.
      const message: OutreachMessage = {
        id: randomUUID(),
        outreachRecordId: rec.id,
        messageType: 'FOLLOW_UP',
        sequenceStep: step,
        subject: input.subject,
        body: input.body,
        contentHash: messageContentHash(input.subject, input.body),
        emailDraftId: input.emailDraftId ?? null,
        finalizedEmailId: input.finalizedEmailId ?? null,
        gmailMessageId: input.gmailMessageId,
        gmailThreadId: input.gmailThreadId,
        approvedAt: nowD,
        sentAt: input.sentAt,
        createdAt: nowD,
      };
      await repos.insertMessage(message);
      await repos.appendEvent({
        outreachRecordId: rec.id,
        type: 'MESSAGE_RECORDED',
        fromStatus: null,
        toStatus: null,
        message: `FOLLOW_UP step ${String(step)} enrolled from confirmed production send`,
        data: {
          contentHash: message.contentHash, gmailMessageId: input.gmailMessageId,
          gmailThreadId: input.gmailThreadId, sendAttemptId: input.sendAttemptId, sequenceStep: step,
        },
      });

      // 4. Mark the matching pending follow-up row SENT. It may legitimately be absent if an
      //    operator cancelled the row while the send was already in flight; the state transition
      //    below is what actually advances the sequence.
      const pending = await repos.pendingFollowups(rec.id);
      const sentFollowup = pending.find((f) => f.step === step) ?? null;
      if (sentFollowup) {
        await repos.updateFollowupStatus(sentFollowup.id, 'SENT', null, nowD);
      }

      // 5. FOLLOW_UP_n_DUE -> FOLLOW_UP_n_SENT, asserted against the state machine.
      const from = followupDueStatus(step);
      const to = followupSentStatus(step);
      assertOutreachTransition(from, to);
      await repos.appendEvent({
        outreachRecordId: rec.id,
        type: 'STATE_TRANSITION',
        fromStatus: from,
        toStatus: to,
        message: `${from} -> ${to} (enroll confirmed follow-up)`,
        data: { sendAttemptId: input.sendAttemptId, sequenceStep: step },
      });

      // 6. Schedule the next step, or end the sequence after the final one.
      const next = nextFollowupStep(step);
      let nextFollowup: OutreachFollowup | null = null;
      let nextDueAt: Date | null = null;
      if (next !== null) {
        nextDueAt = computeFollowupDueUtc({
          previousSentAtMs: input.sentAt.getTime(), step: next, timezone: rec.timezone, policy: input.policy,
        });
        nextFollowup = {
          id: randomUUID(),
          outreachRecordId: rec.id,
          step: next,
          dueAt: nextDueAt,
          timezone: rec.timezone,
          status: 'DUE',
          blockedReason: null,
          cancelledReason: null,
          createdAt: nowD,
          updatedAt: nowD,
        };
        await repos.insertFollowup(nextFollowup);
      }

      const patch: Partial<OutreachRecord> = {
        status: to, lastSentAt: input.sentAt, sequenceStep: step, nextFollowupAt: nextDueAt,
      };
      await repos.updateRecord(rec.id, patch, nowD);

      if (nextFollowup !== null && nextDueAt !== null) {
        await repos.appendEvent({
          outreachRecordId: rec.id,
          type: 'FOLLOWUP_SCHEDULED',
          fromStatus: null,
          toStatus: null,
          message: `Follow-up ${String(next)} due ${nextDueAt.toISOString()}`,
          data: { step: next, dueAt: nextDueAt.toISOString() },
        });
      } else {
        await repos.appendEvent({
          outreachRecordId: rec.id,
          type: 'NOTE',
          fromStatus: null,
          toStatus: null,
          message: 'Sequence complete: the final follow-up was sent; no further email is scheduled.',
          data: { finalStep: step },
        });
      }

      return { outcome: 'ENROLLED', record: { ...rec, ...patch, updatedAt: nowD }, message, sentFollowup, nextFollowup };
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

  /**
   * Promote a record to "follow-up N is due" because its scheduled follow-up row has come due.
   * This is the unattended equivalent of the manual `INITIAL_SENT -> FOLLOW_UP_1_DUE` transition,
   * and it is the ONLY automated writer of a `FOLLOW_UP_N_DUE` status.
   *
   * It grants no new authority: both statuses are non-sending, the follow-up row is not modified,
   * no due date moves, and composing/drafting/scheduling/sending all stay behind their own gates.
   *
   * ATOMICITY. The caller's candidate snapshot is stale by definition, so nothing from it is
   * trusted. Inside ONE transaction this method re-reads the follow-up row and the record, re-runs
   * the SAME pure decision ({@link decideFollowupPromotion}) against that fresh state, and applies
   * the change with a compare-and-set on the expected source status. If a reply, bounce, or a
   * concurrent run moved the record in between, the CAS matches nothing, `RACE_LOST` is returned,
   * and NO event is written — so the immutable timeline can never record a transition that did not
   * happen. The state machine is asserted as a final backstop before the write.
   */
  async promoteFollowupDue(input: PromoteFollowupDueInput): Promise<PromoteFollowupDueResult> {
    return this.uow.transaction(async (repos) => {
      const followup = await repos.getFollowup(input.followupId);
      if (!followup || followup.outreachRecordId !== input.outreachRecordId) {
        return {
          outcome: 'SKIPPED', from: null, to: null,
          detail: `FOLLOWUP_NOT_FOUND: no follow-up ${input.followupId} on record ${input.outreachRecordId}`,
        };
      }
      const rec = await repos.getRecord(input.outreachRecordId);
      const snapshot: FollowupPromotionCandidateView = {
        followupId: followup.id,
        outreachRecordId: input.outreachRecordId,
        leadId: rec?.leadId ?? '',
        step: followup.step,
        followupStatus: followup.status,
        dueAtMs: followup.dueAt.getTime(),
        recordStatus: rec?.status ?? null,
        doNotContact: rec?.doNotContact ?? false,
      };
      const decision = decideFollowupPromotion(snapshot, this.now());
      if (decision.action === 'ALREADY_DUE') {
        return { outcome: 'ALREADY_DUE', from: rec?.status ?? null, to: rec?.status ?? null, detail: decision.detail };
      }
      if (decision.action === 'BLOCKED') {
        return { outcome: 'BLOCKED', from: rec?.status ?? null, to: null, detail: `${decision.reason}: ${decision.detail}` };
      }
      if (decision.action === 'SKIP') {
        return { outcome: 'SKIPPED', from: rec?.status ?? null, to: null, detail: `${decision.reason}: ${decision.detail}` };
      }

      // Backstop: the decision derives both ends from the step, so this can only fire if the
      // sequence map and the state machine ever disagree. Throwing rolls the transaction back.
      assertOutreachTransition(decision.from, decision.to);
      const nowD = new Date(this.now());
      const applied = await repos.updateRecordIfStatus(
        input.outreachRecordId, decision.from, { status: decision.to }, nowD,
      );
      if (!applied) {
        return {
          outcome: 'RACE_LOST', from: decision.from, to: null,
          detail: `record left ${decision.from} before the promotion could be applied; nothing written`,
        };
      }
      await repos.appendEvent({
        outreachRecordId: input.outreachRecordId,
        type: 'STATE_TRANSITION',
        fromStatus: decision.from,
        toStatus: decision.to,
        message: `${decision.from} -> ${decision.to} (follow-up ${String(decision.step)} came due, ${input.actor})`,
        data: {
          trigger: 'FOLLOWUP_DUE',
          automated: true,
          promotedBy: input.actor,
          followupId: followup.id,
          step: decision.step,
          dueAt: followup.dueAt.toISOString(),
        },
      });
      return { outcome: 'PROMOTED', from: decision.from, to: decision.to, detail: `promoted to ${decision.to}` };
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
