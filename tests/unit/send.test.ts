import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { scheduleIntegrityFingerprint } from '../../src/domain/schedule/fingerprint.js';
import { approvedEnvelopeHash, compareProviderEnvelope, expectedDraftEnvelope, recipientHash } from '../../src/domain/send/envelope.js';
import { checkSendEligibility, type ScheduleView, type SendEligibilitySnapshot } from '../../src/domain/send/eligibility.js';
import { SendService, type SendAttemptRecord, type SendConfig, type SendInput, type SendStore, type SendTxRepos, type SendUnitOfWork } from '../../src/domain/send/send-service.js';
import { MockSendProvider, type MockSendScript } from '../../src/integrations/send/mock-send.js';

const LEAD = 'lead-example';
const GMAIL_DRAFT = 'gmail-draft-example';
const PROVIDER_DRAFT = 'provider-draft-example';
const FIN = 'finalization-example';
const CONTENT = 'fictional-content-hash';
const RECIPIENT = 'contact@example.invalid';
const ACCOUNT = 'sender@example.invalid';
const SENDER = 'Example Sender';
const SUBJECT = 'Example subject';
const BODY = 'Hello from {{SENDER_NAME}}';
const POLICY = 'send-policy-1';
const RULES = 'sched-rules-1';
const SCHEDULED = Date.parse('2026-07-20T13:00:00Z');
const NOW = SCHEDULED + 10 * 60_000;
const storedFingerprint = scheduleIntegrityFingerprint({ leadId: LEAD, gmailDraftId: GMAIL_DRAFT,
  providerDraftId: PROVIDER_DRAFT, finalizedContentHash: CONTENT, recipientEmail: RECIPIENT,
  scheduledAtUtcMs: SCHEDULED, rulesVersion: RULES });
const schedule: ScheduleView = { id: 'schedule-example', status: 'SCHEDULED', gmailDraftId: GMAIL_DRAFT,
  providerDraftId: PROVIDER_DRAFT, finalizedContentHash: CONTENT, recipientEmail: RECIPIENT,
  scheduledAtUtcMs: SCHEDULED, rulesVersion: RULES, storedIntegrityFingerprint: storedFingerprint };
const expected = expectedDraftEnvelope({ senderName: SENDER, senderEmail: ACCOUNT, recipientEmail: RECIPIENT, subject: SUBJECT, resolvedBody: BODY });
const readiness = { id: 'readiness-example', gmailAccount: ACCOUNT, policyVersion: POLICY,
  approvedBy: 'Example Operator', approvedAt: new Date(NOW - 1000), expiresAt: new Date(NOW + 60_000), revokedAt: null };
const config: SendConfig = { gmailAccount: ACCOUNT, senderName: SENDER, policyVersion: POLICY,
  sendingEnabled: true, outboundActionsEnabled: true, dryRun: false, maxLateMs: 60 * 60_000, confirmationTtlMs: 120_000, dailyCap: 1 };
const logger = pino({ level: 'silent' });

describe('send envelope', () => {
  it('resolves sender name and detects every provider-envelope mutation', () => {
    expect(expected.body).toBe('Hello from Example Sender');
    expect(recipientHash(RECIPIENT)).not.toContain(RECIPIENT);
    expect(compareProviderEnvelope(expected, { ...expected, cc: ['copy@example.invalid'] })).toContain('unexpected_cc');
    expect(compareProviderEnvelope(expected, { ...expected, body: 'changed' })).toContain('body_changed');
    expect(compareProviderEnvelope(expected, { ...expected, replyTo: 'other@example.invalid' })).toContain('reply_to_changed');
    expect(compareProviderEnvelope(expected, { ...expected, attachmentCount: 1 })).toContain('unexpected_attachment');
  });
});

describe('send eligibility', () => {
  const envelopeHash = approvedEnvelopeHash({ gmailAccount: ACCOUNT, recipientEmail: RECIPIENT, subject: SUBJECT,
    finalizedContentHash: CONTENT, scheduleId: schedule.id, scheduledAtUtcMs: SCHEDULED });
  const base = (): SendEligibilitySnapshot => ({ leadStatus: 'SCHEDULED', schedule,
    recomputedIntegrityFingerprint: storedFingerprint,
    currentGmailDraft: { outcome: 'DRAFT_CREATED', providerDraftId: PROVIDER_DRAFT },
    currentFinalizedContentHash: CONTENT, currentRecipientEmail: RECIPIENT,
    finalizationApproved: true, draftBindingValid: true, gmailAccountMatches: true, draftRecipientMatches: true,
    recipientSuppressed: false,
    readiness: { id: readiness.id, gmailAccount: ACCOUNT, policyVersion: POLICY,
      approvedAtMs: readiness.approvedAt.getTime(), expiresAtMs: readiness.expiresAt.getTime(), revoked: false },
    confirmation: { observedSendFingerprint: 'send-fingerprint', confirmedBy: 'Example Operator', confirmedAtMs: NOW },
    approvedEnvelopeHash: envelopeHash, expectedSendFingerprint: 'send-fingerprint', configGmailAccount: ACCOUNT,
    configPolicyVersion: POLICY, sendingEnabled: true, outboundActionsEnabled: true, dryRun: false,
    nowMs: NOW, maxLateMs: 60 * 60_000, confirmationTtlMs: 120_000,
    hasConfirmedAttempt: false, hasBlockingAttempt: false, lastDefinitiveFailureAtMs: null,
    confirmedSendsToday: 0, dailyCap: 1 });
  it('passes only with intact approval, draft binding, account, recipient, readiness and confirmation', () => {
    expect(checkSendEligibility(base()).eligible).toBe(true);
    expect(checkSendEligibility({ ...base(), finalizationApproved: false }).eligible).toBe(false);
    expect(checkSendEligibility({ ...base(), draftBindingValid: false }).eligible).toBe(false);
    expect(checkSendEligibility({ ...base(), gmailAccountMatches: false }).eligible).toBe(false);
    expect(checkSendEligibility({ ...base(), draftRecipientMatches: false }).eligible).toBe(false);
  });
  it('requires a readiness approval newer than a definitive failure', () => {
    const result = checkSendEligibility({ ...base(), lastDefinitiveFailureAtMs: readiness.approvedAt.getTime() });
    expect(result.reasons).toContain('fresh_readiness_required');
  });
  it('permanently blocks confirmed and uncertain/blocking attempts', () => {
    expect(checkSendEligibility({ ...base(), hasConfirmedAttempt: true }).alreadySent).toBe(true);
    expect(checkSendEligibility({ ...base(), hasBlockingAttempt: true }).blocked).toBe(true);
  });
  it('blocks when the configured account daily cap is reached', () => {
    const result = checkSendEligibility({ ...base(), confirmedSendsToday: 1, dailyCap: 1 });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('daily_cap_reached');
  });
});

interface Capture { patches: Partial<SendAttemptRecord>[]; fulfilled: string[]; invalidated: string[]; transitions: string[] }
const capture = (): Capture => ({ patches: [], fulfilled: [], invalidated: [], transitions: [] });
function uow(cap: Capture): SendUnitOfWork {
  return { async transaction(fn) { return fn({
    leads: { async getById() { return { id: LEAD, status: 'SCHEDULED' } as never; } } as never,
    leadService: { async transition(_id: string, to: string) { cap.transitions.push(to); } } as never,
    completeAttempt: async (_id, patch) => { cap.patches.push(patch); },
    markScheduleFulfilled: async (id) => { cap.fulfilled.push(id); },
    invalidateSchedule: async (id) => { cap.invalidated.push(id); },
    events: { async record() { /* no-op */ } },
  } as SendTxRepos); } };
}
function store(overrides: Partial<SendStore> = {}): SendStore {
  return { async readiness() { return readiness; }, async activeSuppressions() { return []; },
    async hasConfirmedAttempt() { return false; }, async hasBlockingAttempt() { return false; },
    async lastDefinitiveFailureAt() { return null; },
    async confirmedSendsToday() { return 0; }, async reserveAttempt() { return 'reserved'; }, ...overrides };
}
const baseInput = (): SendInput => ({ leadId: LEAD, leadStatus: 'SCHEDULED', schedule,
  currentGmailDraft: { id: GMAIL_DRAFT, outcome: 'DRAFT_CREATED', providerDraftId: PROVIDER_DRAFT,
    providerMessageId: 'message-example', providerThreadId: 'thread-example',
    gmailAccount: ACCOUNT, senderEmail: ACCOUNT, recipientEmail: RECIPIENT, finalizedEmailId: FIN },
  finalization: { id: FIN, resolvedBody: BODY, resolvedBodyHash: CONTENT, finalHumanDecision: 'APPROVED', finalReviewedAt: new Date(NOW - 2000) },
  currentFinalizedContentHash: CONTENT, currentRecipientEmail: RECIPIENT, subject: SUBJECT,
  normalizedDomain: 'example.invalid', normalizedPhone: '+15550100000', placeId: 'place-example',
  confirmation: null, preflightProof: null });
function provider(script: MockSendScript = {}) { return new MockSendProvider({ account: { ok: true, email: ACCOUNT }, draft: {
  outcome: 'ok', providerDraftId: PROVIDER_DRAFT, providerMessageId: 'message-example', providerThreadId: 'thread-example',
  envelope: expected }, ...script }); }
async function confirmedSend(service: SendService, input = baseInput()) {
  const preflight = await service.preflight(input);
  expect(preflight.outcome).toBe('READY');
  const proof = preflight.preflightProof!;
  return service.send({ ...input, preflightProof: proof, confirmation: {
    observedSendFingerprint: proof.sendFingerprint, confirmedBy: 'Example Operator', confirmedAtMs: NOW } }, 'run-example');
}

describe('SendService two-pass control', () => {
  it('verifies account and known draft twice, writes CALL_STARTED, then confirms atomically', async () => {
    const cap = capture(); const mock = provider();
    const service = new SendService({ provider: mock, store: store(), uow: uow(cap), logger, config, now: () => NOW });
    expect((await confirmedSend(service)).outcome).toBe('SENT_CONFIRMED');
    expect(mock.verified).toHaveLength(2); expect(mock.inspected).toEqual([PROVIDER_DRAFT, PROVIDER_DRAFT]);
    expect(mock.sent).toEqual([PROVIDER_DRAFT]);
    expect(cap.patches[0]?.status).toBe('CALL_STARTED');
    expect(cap.patches[1]?.status).toBe('SENT_CONFIRMED');
    expect(cap.fulfilled).toEqual([schedule.id]); expect(cap.transitions).toEqual(['SENT']);
  });
  it('fails closed on provider draft changes before reservation', async () => {
    const cap = capture(); const mock = provider({ draft: { outcome: 'ok', envelope: { ...expected, bcc: ['hidden@example.invalid'] } } });
    const service = new SendService({ provider: mock, store: store(), uow: uow(cap), logger, config, now: () => NOW });
    expect((await service.preflight(baseInput())).outcome).toBe('PROVIDER_VERIFICATION_FAILED');
    expect(mock.sent).toHaveLength(0); expect(cap.patches).toHaveLength(0);
  });
  it('records OUTCOME_UNKNOWN after CALL_STARTED and never fulfills', async () => {
    const cap = capture(); const mock = provider({ send: { outcome: 'unknown', reason: 'timeout' } });
    const service = new SendService({ provider: mock, store: store(), uow: uow(cap), logger, config, now: () => NOW });
    expect((await confirmedSend(service)).outcome).toBe('OUTCOME_UNKNOWN');
    expect(cap.patches.map((x) => x.status)).toEqual(['CALL_STARTED', 'OUTCOME_UNKNOWN']);
    expect(cap.fulfilled).toHaveLength(0); expect(cap.transitions).toEqual(['NEEDS_MANUAL_REVIEW']);
  });
  it('keeps crash recovery out of read-only preflight and permanently blocks a started attempt', async () => {
    const cap = capture();
    const service = new SendService({ provider: provider(), store: store({ async hasBlockingAttempt() { return true; } }), uow: uow(cap), logger, config, now: () => NOW });
    expect((await service.preflight(baseInput())).outcome).toBe('DUPLICATE_PREVENTED');
    expect(cap.patches).toHaveLength(0);
  });
  it('rechecks suppression after provider verification and before reservation', async () => {
    const cap = capture(); const mock = provider(); let checks = 0;
    const service = new SendService({ provider: mock, store: store({ async activeSuppressions() { checks += 1; return checks >= 3 ? ['email'] : []; } }),
      uow: uow(cap), logger, config, now: () => NOW });
    expect((await confirmedSend(service)).outcome).toBe('RECIPIENT_SUPPRESSED');
    expect(mock.sent).toHaveLength(0); expect(cap.patches).toHaveLength(0);
  });
  it('keeps disabled/dry-run execution fully inert', async () => {
    const cap = capture(); const mock = provider();
    const service = new SendService({ provider: mock, store: store(), uow: uow(cap), logger,
      config: { ...config, sendingEnabled: false, dryRun: true }, now: () => NOW });
    expect((await service.preflight(baseInput())).outcome).toBe('SENDING_DISABLED');
    expect(mock.verified).toHaveLength(0); expect(cap.patches).toHaveLength(0);
  });
  it('classifies outbound and dry-run gates before confirmation or readiness findings', async () => {
    const cap = capture(); const mock = provider();
    const outboundOff = new SendService({ provider: mock, store: store(), uow: uow(cap), logger,
      config: { ...config, outboundActionsEnabled: false }, now: () => NOW });
    expect((await outboundOff.send(baseInput(), '')).outcome).toBe('OUTBOUND_ACTIONS_DISABLED');
    const dryRun = new SendService({ provider: mock, store: store(), uow: uow(cap), logger,
      config: { ...config, dryRun: true }, now: () => NOW });
    expect((await dryRun.send(baseInput(), '')).outcome).toBe('DRY_RUN_ACTIVE');
    expect(mock.verified).toHaveLength(0); expect(mock.sent).toHaveLength(0); expect(cap.patches).toHaveLength(0);
  });
  it('blocks before provider access when the account daily cap is reached', async () => {
    const cap = capture(); const mock = provider();
    const service = new SendService({ provider: mock, store: store({ async confirmedSendsToday() { return 1; } }),
      uow: uow(cap), logger, config, now: () => NOW });
    expect((await service.preflight(baseInput())).outcome).toBe('DAILY_CAP_REACHED');
    expect(mock.verified).toHaveLength(0);
  });
  it('rechecks the daily cap atomically at reservation and never dispatches when it fills concurrently', async () => {
    const cap = capture(); const mock = provider();
    const service = new SendService({ provider: mock, store: store({ async reserveAttempt() { return 'daily_cap'; } }),
      uow: uow(cap), logger, config, now: () => NOW });
    expect((await confirmedSend(service)).outcome).toBe('DAILY_CAP_REACHED');
    expect(mock.sent).toHaveLength(0);
    expect(cap.patches).toHaveLength(0);
  });
});
