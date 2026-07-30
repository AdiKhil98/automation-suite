import { randomUUID } from 'node:crypto';
import { type Logger } from 'pino';
import { buildRawMessage } from '../gmail/mime.js';
import { type CreateDraftRequest, type GmailDraftProvider } from '../../integrations/gmail/provider.js';
import { type SendProvider } from '../../integrations/send/provider.js';
import { computeFollowupDueUtc, type SequencePolicy } from './followups.js';
import { messageContentHash, type OutreachMessageType } from './records.js';
import { assertOutreachTransition, canOutreachTransition } from './state-machine.js';
import { type OutreachStatus } from './status.js';

/**
 * Phase 17B — Controlled First Send Smoke Test.
 *
 * This service performs EXACTLY ONE fully-tracked, allowlisted email send and nothing else.
 * It is a dedicated, outreach-native path (campaign → record → INITIAL message step 0 → human
 * approval → immutable events) built on the existing, safeguarded provider primitives:
 *   1. create a Gmail DRAFT (Phase 12 `GmailDraftProvider.createDraft`), then
 *   2. verify that exact known draft, then
 *   3. dispatch it (Phase 15 `SendProvider.sendExistingDraft`).
 *
 * It weakens no global safeguard: the global sending kill switches, the http provider selection,
 * a valid unexpired human approval, an exact sender match, and an allowlisted recipient are ALL
 * required. It sends at most one message, to at most one recipient, with no Cc/Bcc, no scheduling,
 * and never sends a follow-up.
 */

export type SmokeSendOutcome =
  // Terminal success.
  | 'SENT'
  // Global / gate refusals (fail closed).
  | 'SMOKE_TEST_DISABLED'
  | 'SENDING_DISABLED'
  | 'OUTBOUND_DISABLED'
  | 'DRY_RUN_ACTIVE'
  | 'CONFIRMATION_MISSING'
  | 'PROVIDER_NOT_HTTP'
  | 'SENDER_MISMATCH'
  | 'RECIPIENT_NOT_ALLOWLISTED'
  | 'TOO_MANY_RECIPIENTS'
  | 'CC_BCC_NOT_ALLOWED'
  // Record / approval refusals.
  | 'RECORD_NOT_FOUND'
  | 'RECORD_NOT_APPROVED'
  | 'MESSAGE_MISSING'
  | 'CONTENT_HASH_MISMATCH'
  | 'APPROVAL_MISSING'
  | 'APPROVAL_EXPIRED'
  | 'ALREADY_SENT'
  | 'DO_NOT_CONTACT'
  | 'ILLEGAL_TRANSITION'
  // Provider outcomes.
  | 'ACCOUNT_VERIFICATION_FAILED'
  | 'DRAFT_CREATE_FAILED'
  | 'DRAFT_VERIFICATION_FAILED'
  | 'SEND_DEFINITIVE_FAILURE'
  | 'SEND_RATE_LIMITED'
  | 'SEND_AUTH_ERROR'
  | 'SEND_OUTCOME_UNKNOWN'
  // Persistence uncertainty AFTER a confirmed provider send (never auto-retried).
  | 'PERSISTENCE_FAILED_AFTER_SEND';

/** Normalize an email for exact allowlist comparison (trim + lowercase). */
export function normalizeEmail(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

export interface SmokeGuardConfig {
  smokeTestEnabled: boolean;
  sendingEnabled: boolean;
  outboundActionsEnabled: boolean;
  dryRun: boolean;
  /** SENDING_PROVIDER === 'http' — the mock provider can never perform a real smoke send. */
  providerIsHttp: boolean;
  /** The canonical sender identity (GMAIL_ACCOUNT_EMAIL). */
  sender: string | null;
  /** The single allowlisted recipient (OUTREACH_SMOKE_TEST_RECIPIENT). */
  allowedRecipient: string | null;
  /** Human-approval validity window in ms. */
  approvalTtlMs: number;
}

export interface SmokeSendRequest {
  recordId: string;
  confirmPhase17b: boolean;
  /** Operator-supplied sender; must equal config.sender exactly. */
  sender: string;
  /** Operator-supplied recipient; must equal config.allowedRecipient exactly. */
  recipient: string;
  /** Resolved recipient list — must be exactly one address. */
  recipients: string[];
  cc: string[];
  bcc: string[];
}

export interface SmokeContextRecord {
  id: string;
  status: OutreachStatus;
  contactEmail: string;
  doNotContact: boolean;
  timezone: string;
  campaignId: string;
  leadId: string;
}

export interface SmokeContextMessage {
  id: string;
  messageType: OutreachMessageType;
  sequenceStep: number;
  subject: string;
  body: string;
  contentHash: string;
  approvedAt: Date | null;
  sentAt: Date | null;
  gmailMessageId: string | null;
  gmailThreadId: string | null;
}

export interface SmokeContext {
  record: SmokeContextRecord;
  /** The INITIAL step-0 message for this record, or null if none exists. */
  message: SmokeContextMessage | null;
  /** True if ANY prior successful send exists for this record (defensive duplicate guard). */
  priorSuccessfulSend: boolean;
}

export interface SmokeGuardOk {
  ok: true;
  record: SmokeContextRecord;
  message: SmokeContextMessage;
}
export interface SmokeGuardFail {
  ok: false;
  outcome: SmokeSendOutcome;
  reason: string;
}
export type SmokeGuardResult = SmokeGuardOk | SmokeGuardFail;

/**
 * Pure, deterministic evaluation of EVERY precondition. No side effect, no provider or network
 * access — this is the fully unit-testable heart of the safety contract. Returns the first failing
 * guard (fail closed) or an `ok` result carrying the validated record + message.
 */
export function evaluateSmokeSendGuards(
  config: SmokeGuardConfig,
  request: SmokeSendRequest,
  context: SmokeContext,
  nowMs: number,
): SmokeGuardResult {
  const fail = (outcome: SmokeSendOutcome, reason: string): SmokeGuardFail => ({ ok: false, outcome, reason });

  // 1. Phase 17B master switch + the global sending kill switches (all required, fail closed).
  if (!config.smokeTestEnabled) return fail('SMOKE_TEST_DISABLED', 'OUTREACH_SMOKE_TEST_ENABLED is not true');
  if (!config.sendingEnabled) return fail('SENDING_DISABLED', 'SENDING_ENABLED is not true');
  if (!config.outboundActionsEnabled) return fail('OUTBOUND_DISABLED', 'OUTBOUND_ACTIONS_ENABLED is not true');
  if (config.dryRun) return fail('DRY_RUN_ACTIVE', 'DRY_RUN is not false');

  // 2. Explicit Phase 17B confirmation flag.
  if (!request.confirmPhase17b) return fail('CONFIRMATION_MISSING', '--confirm-phase-17b was not provided');

  // 3. The real sending provider must be explicitly selected.
  if (!config.providerIsHttp) return fail('PROVIDER_NOT_HTTP', 'SENDING_PROVIDER must be http for a real send');

  // 4. Exact sender match: configured sender present, and the operator-supplied sender equals it.
  const sender = normalizeEmail(config.sender);
  if (!sender) return fail('SENDER_MISMATCH', 'GMAIL_ACCOUNT_EMAIL (sender identity) is not configured');
  if (normalizeEmail(request.sender) !== sender) {
    return fail('SENDER_MISMATCH', `--sender must equal the configured sender ${sender}`);
  }

  // 5. Allowlisted recipient: configured allowlist present; the request AND the tracked record's
  //    contact must all equal it exactly.
  const allowed = normalizeEmail(config.allowedRecipient);
  if (!allowed) return fail('RECIPIENT_NOT_ALLOWLISTED', 'OUTREACH_SMOKE_TEST_RECIPIENT is not configured');
  if (normalizeEmail(request.recipient) !== allowed) {
    return fail('RECIPIENT_NOT_ALLOWLISTED', `--recipient must equal the allowlisted ${allowed}`);
  }
  if (normalizeEmail(context.record.contactEmail) !== allowed) {
    return fail('RECIPIENT_NOT_ALLOWLISTED', `tracked record contact must equal the allowlisted ${allowed}`);
  }

  // 6. At most one recipient; no Cc/Bcc.
  if (request.recipients.length !== 1 || normalizeEmail(request.recipients[0] ?? '') !== allowed) {
    return fail('TOO_MANY_RECIPIENTS', 'exactly one allowlisted recipient is permitted');
  }
  if (request.cc.length > 0 || request.bcc.length > 0) {
    return fail('CC_BCC_NOT_ALLOWED', 'Cc/Bcc are not permitted for the smoke test');
  }

  // 7. Do-not-contact.
  if (context.record.doNotContact) return fail('DO_NOT_CONTACT', 'record is on do-not-contact');

  // 8. Record must be exactly APPROVED_TO_SEND (a valid human-approval state).
  if (context.record.status !== 'APPROVED_TO_SEND') {
    return fail('RECORD_NOT_APPROVED', `record status must be APPROVED_TO_SEND (is ${context.record.status})`);
  }
  if (!canOutreachTransition(context.record.status, 'INITIAL_SENT')) {
    return fail('ILLEGAL_TRANSITION', `${context.record.status} -> INITIAL_SENT is not a legal transition`);
  }

  // 9. Exactly one stored INITIAL step-0 message.
  const message = context.message;
  if (!message || message.messageType !== 'INITIAL' || message.sequenceStep !== 0) {
    return fail('MESSAGE_MISSING', 'no INITIAL step-0 message stored for this record');
  }

  // 10. Stored exact subject/body hash must match the stored content (integrity).
  if (message.contentHash !== messageContentHash(message.subject, message.body)) {
    return fail('CONTENT_HASH_MISMATCH', 'stored content hash does not match stored subject/body');
  }

  // 11. Valid, unexpired human approval.
  if (!message.approvedAt) return fail('APPROVAL_MISSING', 'message has no human approval');
  if (nowMs - message.approvedAt.getTime() > config.approvalTtlMs) {
    return fail('APPROVAL_EXPIRED', 'human approval has expired');
  }

  // 12. No prior successful send for this message.
  if (message.sentAt !== null || message.gmailMessageId !== null || context.priorSuccessfulSend) {
    return fail('ALREADY_SENT', 'a successful send already exists for this message');
  }

  return { ok: true, record: context.record, message };
}

/** Atomic persistence input applied AFTER a confirmed provider send. */
export interface RecordSendInput {
  recordId: string;
  messageId: string;
  fromStatus: OutreachStatus;
  gmailMessageId: string;
  gmailThreadId: string | null;
  sentAt: Date;
  providerMessageId: string;
  /** Tracking-only follow-up (never sent) created on success. */
  followup: { id: string; step: 1; dueAt: Date; timezone: string };
}

/** Persistence port. `load` reads context; `recordSend` applies all writes atomically. */
export interface SmokeSendStore {
  load(recordId: string): Promise<SmokeContext | null>;
  recordSend(input: RecordSendInput): Promise<void>;
}

export interface SmokeSendServiceDeps {
  draftProvider: GmailDraftProvider;
  sendProvider: SendProvider;
  store: SmokeSendStore;
  config: SmokeGuardConfig;
  senderName: string;
  sequencePolicy: SequencePolicy;
  logger: Logger;
  now?: () => number;
}

export interface SmokeSendResult {
  outcome: SmokeSendOutcome;
  reason?: string;
  recordId: string;
  messageId?: string;
  providerMessageId?: string;
  providerThreadId?: string | null;
  /** Present only for PERSISTENCE_FAILED_AFTER_SEND: the exact idempotent recovery command. */
  recoveryCommand?: string;
}

export class OutreachSmokeSendService {
  private readonly now: () => number;
  constructor(private readonly deps: SmokeSendServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Execute the single controlled send. Every failure is fail-closed and returns a typed outcome;
   * the provider is only ever touched after ALL local guards pass.
   */
  async send(request: SmokeSendRequest): Promise<SmokeSendResult> {
    const context = await this.deps.store.load(request.recordId);
    if (!context) return this.out('RECORD_NOT_FOUND', request.recordId, 'outreach record not found');

    const guard = evaluateSmokeSendGuards(this.deps.config, request, context, this.now());
    if (!guard.ok) return this.out(guard.outcome, request.recordId, guard.reason);
    const { record, message } = guard;
    const sender = normalizeEmail(this.deps.config.sender);
    const recipient = normalizeEmail(this.deps.config.allowedRecipient);

    // Provider step 1: authoritative account verification on the SEND provider (the one that
    // will actually dispatch). The account must resolve to exactly the configured sender.
    const account = await this.deps.sendProvider.verifyAccount(sender);
    if (!account.ok || normalizeEmail(account.email) !== sender) {
      return this.out('ACCOUNT_VERIFICATION_FAILED', request.recordId,
        account.reason ?? `authenticated account is not ${sender}`);
    }

    // Provider step 2: create the Gmail DRAFT with the exact stored subject/body.
    const raw = buildRawMessage({
      fromName: this.deps.senderName,
      fromEmail: sender,
      toEmail: recipient,
      subject: message.subject,
      body: message.body,
    });
    const draftReq: CreateDraftRequest = { rawBase64Url: raw, idempotencyFingerprint: `${message.contentHash}:${record.id}` };
    const draft = await this.deps.draftProvider.createDraft(draftReq);
    if (draft.outcome !== 'ok' || !draft.ref) {
      return this.out('DRAFT_CREATE_FAILED', request.recordId, draft.reason ?? `draft outcome ${draft.outcome}`);
    }
    const providerDraftId = draft.ref.draftId;

    // Provider step 3: read back the EXACT known draft and verify its envelope before sending.
    const known = await this.deps.sendProvider.getKnownDraft(providerDraftId);
    if (known.outcome !== 'ok') {
      return this.out('DRAFT_VERIFICATION_FAILED', request.recordId, `known draft ${known.outcome}: ${known.reason}`);
    }
    const problem = verifyDraftEnvelope(known.envelope, {
      sender, recipient, subject: message.subject, body: message.body,
    });
    if (problem) return this.out('DRAFT_VERIFICATION_FAILED', request.recordId, problem);
    if (!known.providerMessageId || !known.providerThreadId) {
      return this.out('DRAFT_VERIFICATION_FAILED', request.recordId, 'known draft is missing message/thread identity');
    }

    // Provider step 4: dispatch exactly this draft id.
    const send = await this.deps.sendProvider.sendExistingDraft(providerDraftId);
    if (send.outcome === 'rate_limited') return this.out('SEND_RATE_LIMITED', request.recordId, send.reason);
    if (send.outcome === 'auth_error') return this.out('SEND_AUTH_ERROR', request.recordId, send.reason);
    if (send.outcome === 'definitive_failure') return this.out('SEND_DEFINITIVE_FAILURE', request.recordId, send.reason);
    if (send.outcome === 'unknown' || !send.ref?.providerMessageId) {
      // Ambiguous after dispatch — NEVER auto-retry. Recovery is a manual, idempotent reconcile.
      return {
        ...this.out('SEND_OUTCOME_UNKNOWN', request.recordId, send.reason ?? 'provider outcome unknown'),
        messageId: message.id,
        recoveryCommand: reconcileCommand(record.id, null, null),
      };
    }

    // Confirmed send. Persist atomically. A persistence failure here is NOT retried.
    const providerMessageId = send.ref.providerMessageId;
    const providerThreadId = send.ref.providerThreadId ?? known.providerThreadId;
    const sentAt = new Date(this.now());
    const dueAt = computeFollowupDueUtc({
      previousSentAtMs: sentAt.getTime(), step: 1, timezone: record.timezone, policy: this.deps.sequencePolicy,
    });
    // Defensive: the transition is validated in the guard, but assert once more before writing.
    assertOutreachTransition(record.status, 'INITIAL_SENT');
    try {
      await this.deps.store.recordSend({
        recordId: record.id,
        messageId: message.id,
        fromStatus: record.status,
        gmailMessageId: providerMessageId,
        gmailThreadId: providerThreadId,
        sentAt,
        providerMessageId,
        followup: { id: randomUUID(), step: 1, dueAt, timezone: record.timezone },
      });
    } catch (err) {
      this.deps.logger.error({ err, recordId: record.id }, 'smoke send persisted-provider-but-db-failed');
      return {
        ...this.out('PERSISTENCE_FAILED_AFTER_SEND', request.recordId,
          err instanceof Error ? err.message : 'persistence failed after a confirmed send'),
        messageId: message.id,
        providerMessageId,
        providerThreadId,
        recoveryCommand: reconcileCommand(record.id, providerMessageId, providerThreadId),
      };
    }

    return {
      ...this.out('SENT', request.recordId),
      messageId: message.id,
      providerMessageId,
      providerThreadId,
    };
  }

  private out(outcome: SmokeSendOutcome, recordId: string, reason?: string): SmokeSendResult {
    return { outcome, recordId, reason };
  }
}

/** Exact reconcile/recovery command (idempotent; performs NO send). */
export function reconcileCommand(recordId: string, providerMessageId: string | null, providerThreadId: string | null): string {
  const msg = providerMessageId ?? '<gmail-message-id>';
  const thr = providerThreadId ?? '<gmail-thread-id>';
  return `pnpm cli outreach-smoke-reconcile --record ${recordId} --gmail-message-id ${msg} --gmail-thread-id ${thr}`;
}

/**
 * Verify the freshly-created draft's envelope matches the approved content exactly: correct sender,
 * exactly the one allowlisted recipient, no Cc/Bcc, no attachments, exact subject, and a body that
 * matches after CRLF/trailing-whitespace normalization. Returns a reason string on mismatch, else null.
 */
export function verifyDraftEnvelope(
  envelope: { fromEmail: string; to: string[]; cc: string[]; bcc: string[]; subject: string; body: string; attachmentCount: number },
  expected: { sender: string; recipient: string; subject: string; body: string },
): string | null {
  if (normalizeEmail(envelope.fromEmail) !== expected.sender) return 'draft sender mismatch';
  if (envelope.to.length !== 1 || normalizeEmail(envelope.to[0] ?? '') !== expected.recipient) return 'draft recipient mismatch';
  if (envelope.cc.length > 0 || envelope.bcc.length > 0) return 'draft has Cc/Bcc';
  if (envelope.attachmentCount > 0) return 'draft has attachments';
  if (envelope.subject !== expected.subject) return 'draft subject mismatch';
  if (normalizeBody(envelope.body) !== normalizeBody(expected.body)) return 'draft body mismatch';
  return null;
}

function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, '\n').replace(/\s+$/, '');
}
