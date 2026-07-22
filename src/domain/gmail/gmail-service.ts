import { randomUUID } from 'node:crypto';
import { type Logger } from 'pino';
import { sha256Hex } from '../../utils/hash.js';
import { type GmailDraftProvider } from '../../integrations/gmail/provider.js';
import { type LeadService, type LeadStore } from '../leads/lead-service.js';
import { type LeadStatus } from '../leads/status.js';
import { type NewPipelineEvent } from '../pipeline/pipeline-event.js';
import { checkGmailEligibility, type GmailEligibilitySnapshot } from './eligibility.js';
import { buildRawMessage, hasUnresolvedTokens, resolveSenderName } from './mime.js';

export type GmailOutcome =
  | 'DRAFT_CREATED'
  | 'DUPLICATE_REUSED'
  | 'INVALID_ELIGIBILITY'
  | 'INVALID_TOKENS'
  | 'NO_RECIPIENT'
  | 'ACCOUNT_MISMATCH'
  | 'DRAFT_FAILED'
  | 'AUTH_ERROR'
  | 'RATE_LIMITED'
  | 'TRANSIENT_ERROR'
  | 'BUDGET_BLOCKED'
  | 'MANUAL_REVIEW_REQUIRED';

export interface GmailConfig {
  gmailAccount: string;
  senderName: string | null;
  featureEnabled: boolean;
  draftActionsEnabled: boolean;
  credentialsConfigured: boolean;
  maxPerDay: number;
  minIntervalMs: number;
}

export interface GmailInput {
  leadId: string;
  leadStatus: string;
  finalization: { id: string; resolvedBody: string; resolvedBodyHash: string; finalHumanDecision: string | null } | null;
  subject: string;
  recipientEmail: string | null;
}

export interface GmailDraftRecord {
  id: string;
  leadId: string;
  finalizedEmailId: string | null;
  recipientEmail: string;
  senderEmail: string;
  gmailAccount: string;
  provider: string;
  providerDraftId: string | null;
  threadId: string | null;
  messageId: string | null;
  idempotencyFingerprint: string;
  sourceEmailVersion: string;
  outcome: GmailOutcome;
  errorClass: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface GmailStore {
  draftsToday(now: Date): Promise<number>;
  lastAttemptAt(): Promise<Date | null>;
  existingByFingerprint(account: string, fingerprint: string): Promise<boolean>;
  findReservedByFingerprint(fingerprint: string): Promise<GmailDraftRecord | null>;
  reserveRun(row: GmailDraftRecord): Promise<void>;
}

export interface GmailTxRepos {
  leads: LeadStore;
  leadService: LeadService;
  completeRun(runId: string, patch: Partial<GmailDraftRecord>): Promise<void>;
  events: { record(e: NewPipelineEvent): Promise<void> };
}
export interface GmailUnitOfWork {
  transaction<T>(fn: (repos: GmailTxRepos) => Promise<T>): Promise<T>;
}

export interface GmailServiceDeps {
  provider: GmailDraftProvider;
  store: GmailStore;
  uow: GmailUnitOfWork;
  logger: Logger;
  config: GmailConfig;
}

export interface GmailResultOut {
  leadId: string;
  outcome: GmailOutcome;
  draftId: string | null;
}

/**
 * Phase 12 Gmail draft orchestration for ONE approved lead. Fail-closed: eligibility →
 * resolve {{SENDER_NAME}} + assert no tokens remain → verify account → build MIME → idempotent
 * reserve → create DRAFT (never send) → persist. Duplicate prevention via a persisted attempt
 * fingerprint + DB unique constraint. Transient/rate-limited stay retryable at HUMAN_APPROVED;
 * a verified draft advances to DRAFT_CREATED; auth/account/uncertain conditions → manual review.
 * Recipients are never invented; the finalized body is preserved (only the sender name resolves).
 */
export class GmailDraftService {
  constructor(private readonly deps: GmailServiceDeps) {}

  async createDraft(input: GmailInput, runId: string): Promise<GmailResultOut> {
    const c = this.deps.config;
    const now = new Date();

    const fingerprint = input.finalization && input.recipientEmail
      ? sha256Hex(`${c.gmailAccount}|${input.finalization.id}|${input.recipientEmail}`)
      : sha256Hex(`${c.gmailAccount}|${input.leadId}|none`);
    const existingDraft = await this.deps.store.existingByFingerprint(c.gmailAccount, fingerprint);

    const snapshot: GmailEligibilitySnapshot = {
      leadStatus: input.leadStatus,
      finalization: input.finalization ? { finalHumanDecision: input.finalization.finalHumanDecision, resolvedBody: input.finalization.resolvedBody } : null,
      recipientEmail: input.recipientEmail,
      featureEnabled: c.featureEnabled,
      draftActionsEnabled: c.draftActionsEnabled,
      credentialsConfigured: c.credentialsConfigured,
      existingDraftForFingerprint: existingDraft,
    };
    const elig = checkGmailEligibility(snapshot);
    if (elig.duplicateReusable) return this.terminal(input, runId, 'DUPLICATE_REUSED', null, 'duplicate', null);
    if (!elig.eligible) {
      const outcome: GmailOutcome = elig.reasons.some((r) => r.startsWith('no_verified_recipient') || r.startsWith('recipient_')) ? 'NO_RECIPIENT' : 'INVALID_ELIGIBILITY';
      return this.terminal(input, runId, outcome, null, elig.reasons.join(','), null);
    }

    // ---- Resolve sender name + assert no unresolved tokens. ----
    if (!c.senderName) return this.terminal(input, runId, 'INVALID_TOKENS', 'NEEDS_MANUAL_REVIEW', 'sender_name_not_configured', null);
    const finalization = input.finalization!;
    const recipient = input.recipientEmail!;
    const resolvedBody = resolveSenderName(finalization.resolvedBody, c.senderName);
    if (hasUnresolvedTokens(resolvedBody)) return this.terminal(input, runId, 'INVALID_TOKENS', 'NEEDS_MANUAL_REVIEW', 'unresolved_tokens_after_substitution', null);

    // ---- Verify the authorized account matches the configured account (fail-closed). ----
    const verify = await this.deps.provider.verifyAccount(c.gmailAccount);
    if (verify.email !== null && verify.email !== c.gmailAccount) {
      return this.terminal(input, runId, 'ACCOUNT_MISMATCH', 'NEEDS_MANUAL_REVIEW', 'account_mismatch', null);
    }
    if (!verify.ok || verify.email === null) {
      return this.terminal(input, runId, 'AUTH_ERROR', 'NEEDS_MANUAL_REVIEW', 'account_verification_failed', null);
    }

    // ---- Idempotent reserve/reconcile. ----
    const reserved = await this.deps.store.findReservedByFingerprint(fingerprint);
    if (reserved?.providerDraftId) return this.terminal(input, runId, 'DUPLICATE_REUSED', null, 'reused_reserved', reserved.id);
    if (reserved && !reserved.providerDraftId) {
      // A prior attempt may have created a draft but not persisted its id — do NOT recreate
      // (would risk a duplicate Gmail draft). Park for a human to reconcile.
      return this.terminal(input, runId, 'MANUAL_REVIEW_REQUIRED', 'NEEDS_MANUAL_REVIEW', 'uncertain_prior_attempt', reserved.id);
    }

    // Throttle only a genuine new create.
    if (await this.deps.store.draftsToday(now) >= c.maxPerDay) return this.terminal(input, runId, 'BUDGET_BLOCKED', null, 'max_per_day', null);
    const last = await this.deps.store.lastAttemptAt();
    if (last && now.getTime() - last.getTime() < c.minIntervalMs) return this.terminal(input, runId, 'BUDGET_BLOCKED', null, 'min_interval', null);

    const run: GmailDraftRecord = {
      id: randomUUID(), leadId: input.leadId, finalizedEmailId: finalization.id, recipientEmail: recipient, senderEmail: c.gmailAccount,
      gmailAccount: c.gmailAccount, provider: this.deps.provider.name, providerDraftId: null, threadId: null, messageId: null,
      idempotencyFingerprint: fingerprint, sourceEmailVersion: finalization.resolvedBodyHash, outcome: 'TRANSIENT_ERROR',
      errorClass: null, createdAt: now, completedAt: null,
    };
    await this.deps.store.reserveRun(run);

    const raw = buildRawMessage({ fromName: c.senderName, fromEmail: c.gmailAccount, toEmail: recipient, subject: input.subject, body: resolvedBody });
    const res = await this.deps.provider.createDraft({ rawBase64Url: raw, idempotencyFingerprint: fingerprint });
    if (res.outcome === 'rate_limited') return this.terminal(input, runId, 'RATE_LIMITED', null, 'create_rate_limited', run.id);
    if (res.outcome === 'transient') return this.terminal(input, runId, 'TRANSIENT_ERROR', null, 'create_transient', run.id);
    if (res.outcome === 'auth_error') return this.terminal(input, runId, 'AUTH_ERROR', 'NEEDS_MANUAL_REVIEW', 'auth_error', run.id);
    if (res.outcome !== 'ok' || !res.ref) return this.terminal(input, runId, 'DRAFT_FAILED', 'NEEDS_MANUAL_REVIEW', res.reason ?? 'create_failed', run.id);

    // ---- Draft created: persist the ref + advance the lead. ----
    return this.finish(input, runId, run.id, res.ref);
  }

  private async terminal(input: GmailInput, runId: string, outcome: GmailOutcome, route: LeadStatus | null, errorClass: string | null, reservedRunId: string | null): Promise<GmailResultOut> {
    await this.deps.uow.transaction(async (repos) => {
      if (reservedRunId) await repos.completeRun(reservedRunId, { outcome, errorClass, completedAt: new Date() });
      if (route) {
        const lead = await repos.leads.getById(input.leadId);
        if (lead && lead.status === 'HUMAN_APPROVED') await repos.leadService.transition(input.leadId, route);
      }
      await repos.events.record({ leadId: input.leadId, runId, type: 'NOTE', fromStatus: null, toStatus: null, message: `gmail: ${outcome}`, data: { outcome, errorClass } });
    });
    return { leadId: input.leadId, outcome, draftId: null };
  }

  private async finish(input: GmailInput, runId: string, reservedRunId: string, ref: { draftId: string; messageId: string | null; threadId: string | null }): Promise<GmailResultOut> {
    await this.deps.uow.transaction(async (repos) => {
      await repos.completeRun(reservedRunId, { outcome: 'DRAFT_CREATED', providerDraftId: ref.draftId, messageId: ref.messageId, threadId: ref.threadId, errorClass: null, completedAt: new Date() });
      const lead = await repos.leads.getById(input.leadId);
      if (lead && lead.status === 'HUMAN_APPROVED') await repos.leadService.transition(input.leadId, 'DRAFT_CREATED');
      await repos.events.record({ leadId: input.leadId, runId, type: 'NOTE', fromStatus: null, toStatus: null, message: 'gmail: DRAFT_CREATED', data: { draftId: ref.draftId, threadId: ref.threadId } });
    });
    return { leadId: input.leadId, outcome: 'DRAFT_CREATED', draftId: ref.draftId };
  }
}
