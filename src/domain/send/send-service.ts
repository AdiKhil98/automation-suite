import { randomUUID } from 'node:crypto';
import { type Logger } from 'pino';
import { type SendProvider } from '../../integrations/send/provider.js';
import { type LeadService, type LeadStore } from '../leads/lead-service.js';
import { type NewPipelineEvent } from '../pipeline/pipeline-event.js';
import { scheduleIntegrityFingerprint } from '../schedule/fingerprint.js';
import { checkSendEligibility, type ConfirmationView, type ReadinessView, type ScheduleView, type SendEligibilitySnapshot } from './eligibility.js';
import { approvedEnvelopeHash, compareProviderEnvelope, confirmationFingerprint, expectedDraftEnvelope,
  preflightProofHash, providerEnvelopeHash, recipientHash, sendFingerprint } from './envelope.js';

export type SendOutcome = 'READY' | 'SENT_CONFIRMED' | 'SENDING_DISABLED' | 'INVALID_ELIGIBILITY' |
  'READINESS_INVALID' | 'NOT_CONFIRMED' | 'PROVIDER_VERIFICATION_FAILED' | 'BINDING_INVALIDATED' |
  'TOO_LATE' | 'RECIPIENT_SUPPRESSED' | 'NOT_DUE' | 'ALREADY_SENT' | 'DUPLICATE_PREVENTED' |
  'RATE_LIMITED' | 'TRANSIENT_ERROR' | 'AUTH_ERROR' | 'OUTCOME_UNKNOWN';
export type SendAttemptStatus = 'RESERVED' | 'CALL_STARTED' | 'SENT_CONFIRMED' | 'DEFINITIVE_FAILURE' | 'OUTCOME_UNKNOWN' | 'DUPLICATE_PREVENTED';

export interface SendingReadinessRecord { id: string; gmailAccount: string; policyVersion: string; approvedBy: string; approvedAt: Date; expiresAt: Date; revokedAt: Date | null }
export interface SendAttemptRecord {
  id: string; leadId: string; scheduleId: string; gmailDraftId: string; readinessApprovalId: string;
  gmailAccount: string; recipientHash: string; finalizedContentHash: string; scheduleIntegrityFingerprint: string;
  approvedEnvelopeHash: string; observedEnvelopeHash: string; sendFingerprint: string;
  confirmationFingerprint: string; confirmedBy: string; confirmedAt: Date; status: SendAttemptStatus;
  providerMessageId: string | null; providerThreadId: string | null; errorClass: string | null;
  reservedAt: Date; callStartedAt: Date | null; completedAt: Date | null;
}
export interface SendStore {
  readiness(account: string, policy: string): Promise<SendingReadinessRecord | null>;
  isEmailSuppressed(email: string): Promise<boolean>;
  hasConfirmedAttempt(scheduleId: string): Promise<boolean>;
  hasBlockingAttempt(scheduleId: string): Promise<boolean>;
  lastDefinitiveFailureAt(scheduleId: string): Promise<Date | null>;
  /** Crash recovery: a persisted CALL_STARTED has an uncertain provider outcome and is blocking. */
  promoteStartedToUnknown(scheduleId: string, now: Date): Promise<void>;
  reserveAttempt(row: SendAttemptRecord): Promise<boolean>;
}
export interface SendTxRepos {
  leads: LeadStore; leadService: LeadService;
  completeAttempt(id: string, patch: Partial<SendAttemptRecord>): Promise<void>;
  markScheduleFulfilled(id: string, now: Date): Promise<void>;
  invalidateSchedule(id: string, reason: string, now: Date): Promise<void>;
  events: { record(e: NewPipelineEvent): Promise<void> };
}
export interface SendUnitOfWork { transaction<T>(fn: (repos: SendTxRepos) => Promise<T>): Promise<T> }
export interface SendConfig {
  gmailAccount: string; senderName: string | null; policyVersion: string; sendingEnabled: boolean;
  outboundActionsEnabled: boolean; dryRun: boolean; maxLateMs: number; confirmationTtlMs: number;
}
export interface SendServiceDeps { provider: SendProvider; store: SendStore; uow: SendUnitOfWork; logger: Logger; config: SendConfig; now?: () => number }
export interface SendInput {
  leadId: string; leadStatus: string; schedule: ScheduleView | null;
  currentGmailDraft: { id: string; outcome: string; providerDraftId: string | null; gmailAccount: string; senderEmail: string; recipientEmail: string; finalizedEmailId: string | null } | null;
  finalization: { id: string; resolvedBody: string; resolvedBodyHash: string; finalHumanDecision: string | null; finalReviewedAt: Date | null } | null;
  currentFinalizedContentHash: string | null; currentRecipientEmail: string | null; subject: string | null;
  confirmation: ConfirmationView | null; preflightProof: PreflightProof | null;
}
export interface PreflightProof { sendFingerprint: string; providerEnvelopeHash: string; checkedAtMs: number; proofHash: string }
export interface SendResultOut { leadId: string; outcome: SendOutcome; reason?: string; preflightProof?: PreflightProof }

export class SendService {
  private readonly now: () => number;
  constructor(private readonly deps: SendServiceDeps) { this.now = deps.now ?? Date.now; }

  /** First read-only provider verification, performed before the operator is prompted. */
  async preflight(input: SendInput): Promise<SendResultOut> {
    const state = await this.state(input, false, true);
    if ('result' in state) return state.result;
    const provider = await this.verifyProvider(state.expected, input.currentGmailDraft?.providerDraftId ?? '');
    if (!provider.ok) return this.out(input.leadId, 'PROVIDER_VERIFICATION_FAILED', provider.reason);
    const checkedAtMs = this.now();
    const proof: PreflightProof = { sendFingerprint: state.sendFp, providerEnvelopeHash: provider.envelopeHash,
      checkedAtMs, proofHash: preflightProofHash(state.sendFp, provider.envelopeHash, checkedAtMs) };
    return { leadId: input.leadId, outcome: 'READY', preflightProof: proof };
  }

  /** Second verification occurs after confirmation and immediately before reservation. */
  async send(input: SendInput, runId: string): Promise<SendResultOut> {
    const state = await this.state(input, true, true);
    if ('result' in state) return state.result;
    const proof = input.preflightProof;
    if (!proof || proof.sendFingerprint !== state.sendFp ||
        proof.proofHash !== preflightProofHash(proof.sendFingerprint, proof.providerEnvelopeHash, proof.checkedAtMs) ||
        this.now() - proof.checkedAtMs > this.deps.config.confirmationTtlMs) {
      return this.out(input.leadId, 'NOT_CONFIRMED', 'preflight_proof_invalid_or_expired');
    }
    const provider = await this.verifyProvider(state.expected, input.currentGmailDraft?.providerDraftId ?? '');
    if (!provider.ok || provider.envelopeHash !== proof.providerEnvelopeHash) {
      return this.out(input.leadId, 'PROVIDER_VERIFICATION_FAILED', provider.ok ? 'draft_changed_after_confirmation' : provider.reason);
    }
    const confirmation = input.confirmation as ConfirmationView;
    const attempt: SendAttemptRecord = {
      id: randomUUID(), leadId: input.leadId, scheduleId: state.schedule.id,
      gmailDraftId: state.schedule.gmailDraftId, readinessApprovalId: state.readiness.id,
      gmailAccount: this.deps.config.gmailAccount, recipientHash: recipientHash(input.currentRecipientEmail as string),
      finalizedContentHash: input.currentFinalizedContentHash as string,
      scheduleIntegrityFingerprint: state.schedule.storedIntegrityFingerprint,
      approvedEnvelopeHash: state.envelopeHash, observedEnvelopeHash: state.envelopeHash,
      sendFingerprint: state.sendFp,
      confirmationFingerprint: confirmationFingerprint({ approvedEnvelopeHash: state.sendFp,
        confirmedBy: confirmation.confirmedBy, observedEnvelopeHash: confirmation.observedSendFingerprint }),
      confirmedBy: confirmation.confirmedBy, confirmedAt: new Date(confirmation.confirmedAtMs), status: 'RESERVED',
      providerMessageId: null, providerThreadId: null, errorClass: null, reservedAt: new Date(), callStartedAt: null, completedAt: null,
    };
    if (!(await this.deps.store.reserveAttempt(attempt))) return this.out(input.leadId, 'DUPLICATE_PREVENTED', 'reserve_conflict');

    const callStartedAt = new Date();
    await this.deps.uow.transaction((repos) => repos.completeAttempt(attempt.id, { status: 'CALL_STARTED', callStartedAt }));
    let response;
    try { response = await this.deps.provider.sendExistingDraft(input.currentGmailDraft?.providerDraftId as string); }
    catch { return this.finishUnknown(input, runId, attempt.id, callStartedAt, 'provider_exception'); }
    if (response.outcome === 'ok' && response.ref?.providerMessageId) {
      await this.deps.uow.transaction(async (repos) => {
        await repos.completeAttempt(attempt.id, { status: 'SENT_CONFIRMED', providerMessageId: response.ref?.providerMessageId ?? null,
          providerThreadId: response.ref?.providerThreadId ?? null, completedAt: new Date() });
        await repos.markScheduleFulfilled(state.schedule.id, new Date());
        const lead = await repos.leads.getById(input.leadId);
        if (lead?.status === 'SCHEDULED') await repos.leadService.transition(input.leadId, 'SENT');
        await repos.events.record(this.note(input.leadId, runId, 'SENT_CONFIRMED', { providerConfirmed: true }));
      });
      return this.out(input.leadId, 'SENT_CONFIRMED');
    }
    if (response.outcome === 'unknown' || (response.outcome === 'ok' && !response.ref?.providerMessageId)) {
      return this.finishUnknown(input, runId, attempt.id, callStartedAt, 'provider_outcome_unknown');
    }
    const outcome: SendOutcome = response.outcome === 'rate_limited' ? 'RATE_LIMITED' : response.outcome === 'transient' ? 'TRANSIENT_ERROR' : 'AUTH_ERROR';
    await this.deps.uow.transaction(async (repos) => {
      await repos.completeAttempt(attempt.id, { status: 'DEFINITIVE_FAILURE', errorClass: response.outcome, completedAt: new Date() });
      await repos.events.record(this.note(input.leadId, runId, outcome, { errorClass: response.outcome }));
    });
    return this.out(input.leadId, outcome, response.reason);
  }

  private async state(input: SendInput, requireConfirmation: boolean, mutateInvalid: boolean): Promise<{
    schedule: ScheduleView; readiness: SendingReadinessRecord; envelopeHash: string; sendFp: string;
    expected: ReturnType<typeof expectedDraftEnvelope>;
  } | { result: SendResultOut }> {
    const c = this.deps.config;
    if (!c.sendingEnabled || !c.outboundActionsEnabled || c.dryRun) return { result: this.out(input.leadId, 'SENDING_DISABLED', 'kill_switch_not_armed') };
    if (!input.schedule) return { result: this.out(input.leadId, 'INVALID_ELIGIBILITY', 'no_active_schedule') };
    const sched = input.schedule;
    await this.deps.store.promoteStartedToUnknown(sched.id, new Date(this.now()));
    const draft = input.currentGmailDraft;
    const recipient = input.currentRecipientEmail;
    const recomputed = draft?.providerDraftId && input.currentFinalizedContentHash && recipient
      ? scheduleIntegrityFingerprint({ leadId: input.leadId, gmailDraftId: draft.id, providerDraftId: draft.providerDraftId,
          finalizedContentHash: input.currentFinalizedContentHash, recipientEmail: recipient,
          scheduledAtUtcMs: sched.scheduledAtUtcMs, rulesVersion: sched.rulesVersion }) : null;
    const envelopeHash = approvedEnvelopeHash({ gmailAccount: c.gmailAccount, recipientEmail: recipient ?? '',
      subject: input.subject ?? '', finalizedContentHash: input.currentFinalizedContentHash ?? '', scheduleId: sched.id,
      scheduledAtUtcMs: sched.scheduledAtUtcMs });
    const readiness = await this.deps.store.readiness(c.gmailAccount, c.policyVersion);
    const sendFp = readiness ? sendFingerprint({ scheduleId: sched.id, gmailDraftId: sched.gmailDraftId,
      approvedEnvelopeHash: envelopeHash, readinessApprovalId: readiness.id }) : '';
    const suppressed = recipient ? await this.deps.store.isEmailSuppressed(recipient) : false;
    const lastFailure = await this.deps.store.lastDefinitiveFailureAt(sched.id);
    const readinessView: ReadinessView | null = readiness ? { id: readiness.id, gmailAccount: readiness.gmailAccount,
      policyVersion: readiness.policyVersion, approvedAtMs: readiness.approvedAt.getTime(), expiresAtMs: readiness.expiresAt.getTime(), revoked: readiness.revokedAt !== null } : null;
    const snapshot: SendEligibilitySnapshot = {
      leadStatus: input.leadStatus, schedule: sched, recomputedIntegrityFingerprint: recomputed,
      currentGmailDraft: draft ? { outcome: draft.outcome, providerDraftId: draft.providerDraftId } : null,
      currentFinalizedContentHash: input.currentFinalizedContentHash, currentRecipientEmail: recipient,
      finalizationApproved: input.finalization?.finalHumanDecision === 'APPROVED' && input.finalization.finalReviewedAt !== null,
      draftBindingValid: !!draft && draft.id === sched.gmailDraftId && draft.finalizedEmailId === input.finalization?.id,
      gmailAccountMatches: !!draft && draft.gmailAccount.toLowerCase() === c.gmailAccount.toLowerCase(),
      draftRecipientMatches: !!draft && !!recipient && draft.recipientEmail.toLowerCase() === recipient.toLowerCase(),
      recipientSuppressed: suppressed, readiness: readinessView, confirmation: input.confirmation,
      approvedEnvelopeHash: envelopeHash, expectedSendFingerprint: sendFp,
      configGmailAccount: c.gmailAccount, configPolicyVersion: c.policyVersion,
      sendingEnabled: c.sendingEnabled, outboundActionsEnabled: c.outboundActionsEnabled, dryRun: c.dryRun,
      nowMs: this.now(), maxLateMs: c.maxLateMs, confirmationTtlMs: c.confirmationTtlMs,
      hasConfirmedAttempt: await this.deps.store.hasConfirmedAttempt(sched.id),
      hasBlockingAttempt: await this.deps.store.hasBlockingAttempt(sched.id),
      lastDefinitiveFailureAtMs: lastFailure?.getTime() ?? null,
    };
    const elig = checkSendEligibility(snapshot, { requireConfirmation });
    if (!elig.eligible) {
      if (elig.alreadySent) return { result: this.out(input.leadId, 'ALREADY_SENT', 'already_sent') };
      if (elig.blocked) return { result: this.out(input.leadId, 'DUPLICATE_PREVENTED', 'blocking_attempt_exists') };
      if (elig.bindingInvalid) return { result: mutateInvalid ? await this.routeInvalidate(input, '', 'BINDING_INVALIDATED', 'binding_invalidated') : this.out(input.leadId, 'BINDING_INVALIDATED', 'binding_invalidated') };
      if (elig.tooLate) return { result: mutateInvalid ? await this.routeInvalidate(input, '', 'TOO_LATE', 'too_late') : this.out(input.leadId, 'TOO_LATE', 'too_late') };
      if (elig.suppressed) return { result: mutateInvalid ? await this.routeManual(input, '', 'RECIPIENT_SUPPRESSED', 'recipient_suppressed') : this.out(input.leadId, 'RECIPIENT_SUPPRESSED', 'recipient_suppressed') };
      if (elig.notDue) return { result: this.out(input.leadId, 'NOT_DUE', 'not_due') };
      const outcome: SendOutcome = elig.reasons.some((r) => r.includes('readiness')) ? 'READINESS_INVALID' : elig.reasons.some((r) => r.includes('confirmation')) ? 'NOT_CONFIRMED' : 'INVALID_ELIGIBILITY';
      return { result: this.out(input.leadId, outcome, elig.reasons.join(',')) };
    }
    if (!c.senderName || !draft || !recipient || !input.subject || !input.finalization) return { result: this.out(input.leadId, 'INVALID_ELIGIBILITY', 'approved_envelope_incomplete') };
    let expected;
    try { expected = expectedDraftEnvelope({ senderName: c.senderName, senderEmail: draft.senderEmail,
      recipientEmail: recipient, subject: input.subject, resolvedBody: input.finalization.resolvedBody }); }
    catch { return { result: this.out(input.leadId, 'INVALID_ELIGIBILITY', 'approved_envelope_invalid') }; }
    return { schedule: sched, readiness: readiness as SendingReadinessRecord, envelopeHash, sendFp, expected };
  }

  private async verifyProvider(expected: ReturnType<typeof expectedDraftEnvelope>, draftId: string): Promise<{ ok: true; envelopeHash: string } | { ok: false; reason: string }> {
    const account = await this.deps.provider.verifyAccount(this.deps.config.gmailAccount);
    if (!account.ok || account.email?.toLowerCase() !== this.deps.config.gmailAccount.toLowerCase()) return { ok: false, reason: 'authenticated_account_mismatch' };
    const draft = await this.deps.provider.getKnownDraft(draftId);
    if (draft.outcome !== 'ok') return { ok: false, reason: `known_draft_${draft.outcome}` };
    const problems = compareProviderEnvelope(expected, draft.envelope);
    if (problems.length > 0) return { ok: false, reason: problems.join(',') };
    return { ok: true, envelopeHash: providerEnvelopeHash(draft.envelope) };
  }

  private async finishUnknown(input: SendInput, runId: string, attemptId: string, callStartedAt: Date, reason: string): Promise<SendResultOut> {
    await this.deps.uow.transaction(async (repos) => {
      await repos.completeAttempt(attemptId, { status: 'OUTCOME_UNKNOWN', errorClass: 'unknown', callStartedAt, completedAt: new Date() });
      const lead = await repos.leads.getById(input.leadId);
      if (lead?.status === 'SCHEDULED') await repos.leadService.transition(input.leadId, 'NEEDS_MANUAL_REVIEW');
      await repos.events.record(this.note(input.leadId, runId, 'OUTCOME_UNKNOWN', { manualReconcileRequired: true }));
    });
    return this.out(input.leadId, 'OUTCOME_UNKNOWN', reason);
  }
  private async routeInvalidate(input: SendInput, runId: string, outcome: SendOutcome, reason: string): Promise<SendResultOut> {
    await this.deps.uow.transaction(async (repos) => { if (input.schedule) await repos.invalidateSchedule(input.schedule.id, reason, new Date());
      const lead = await repos.leads.getById(input.leadId); if (lead?.status === 'SCHEDULED') await repos.leadService.transition(input.leadId, 'NEEDS_MANUAL_REVIEW');
      await repos.events.record(this.note(input.leadId, runId, outcome, { reason })); });
    return this.out(input.leadId, outcome, reason);
  }
  private async routeManual(input: SendInput, runId: string, outcome: SendOutcome, reason: string): Promise<SendResultOut> {
    await this.deps.uow.transaction(async (repos) => { const lead = await repos.leads.getById(input.leadId);
      if (lead?.status === 'SCHEDULED') await repos.leadService.transition(input.leadId, 'NEEDS_MANUAL_REVIEW');
      await repos.events.record(this.note(input.leadId, runId, outcome, { reason })); });
    return this.out(input.leadId, outcome, reason);
  }
  private note(leadId: string, runId: string, outcome: SendOutcome, data: Record<string, unknown>): NewPipelineEvent {
    return { leadId, runId: runId || null, type: 'NOTE', fromStatus: null, toStatus: null, message: `send: ${outcome}`, data };
  }
  private out(leadId: string, outcome: SendOutcome, reason?: string): SendResultOut { return { leadId, outcome, reason }; }
}
