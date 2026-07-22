import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { base64Url, buildRawMessage, hasUnresolvedTokens, resolveSenderName } from '../../src/domain/gmail/mime.js';
import { checkGmailEligibility, type GmailEligibilitySnapshot } from '../../src/domain/gmail/eligibility.js';
import {
  GmailDraftService, type GmailConfig, type GmailDraftRecord, type GmailInput, type GmailStore, type GmailUnitOfWork,
} from '../../src/domain/gmail/gmail-service.js';
import { MockGmailDraftProvider } from '../../src/integrations/gmail/mock-gmail.js';

const ACCOUNT = 'sender@example.com';
const RECIP = 'office@example.org';
const BODY = 'Hallo,\n\nDas Konzept: https://demo.example.net/\n\nBeste Grüße\n{{SENDER_NAME}}';

describe('gmail mime', () => {
  it('resolves the sender name and flags any leftover token', () => {
    const r = resolveSenderName(BODY, 'Adi K');
    expect(r).toContain('Beste Grüße\nAdi K');
    expect(hasUnresolvedTokens(r)).toBe(false);
    expect(hasUnresolvedTokens('still {{DEMO_URL}}')).toBe(true);
  });
  it('builds a base64url RFC5322 message with encoded non-ASCII subject', () => {
    const raw = buildRawMessage({ fromName: 'Adi K', fromEmail: ACCOUNT, toEmail: RECIP, subject: 'Anregung für Ihre Website', body: resolveSenderName(BODY, 'Adi K') });
    expect(raw).not.toMatch(/[+/=]/); // base64url
    const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    expect(decoded).toContain(`To: ${RECIP}`);
    expect(decoded).toContain(`From: Adi K <${ACCOUNT}>`);
    expect(decoded).toMatch(/Subject: =\?UTF-8\?B\?/); // encoded-word for the umlaut
    expect(decoded).toContain('Beste Grüße\nAdi K');
    expect(decoded).not.toContain('{{SENDER_NAME}}');
  });
  it('base64Url has no padding or +/', () => {
    expect(base64Url(Buffer.from('any??>>'))).not.toMatch(/[+/=]/);
  });
});

describe('gmail eligibility', () => {
  const base = (): GmailEligibilitySnapshot => ({
    leadStatus: 'HUMAN_APPROVED',
    finalization: { finalHumanDecision: 'APPROVED', resolvedBody: BODY },
    recipientEmail: RECIP, featureEnabled: true, draftActionsEnabled: true, credentialsConfigured: true, existingDraftForFingerprint: false,
  });
  it('passes when all conditions hold (only {{SENDER_NAME}} remains)', () => {
    expect(checkGmailEligibility(base()).eligible).toBe(true);
  });
  it('fails closed on each broken condition', () => {
    expect(checkGmailEligibility({ ...base(), leadStatus: 'DRAFT_CREATED' }).eligible).toBe(false);
    expect(checkGmailEligibility({ ...base(), finalization: { finalHumanDecision: null, resolvedBody: BODY } }).eligible).toBe(false);
    expect(checkGmailEligibility({ ...base(), finalization: { finalHumanDecision: 'APPROVED', resolvedBody: 'x {{DEMO_URL}}' } }).reasons).toContain('unresolved_demo_url');
    expect(checkGmailEligibility({ ...base(), finalization: { finalHumanDecision: 'APPROVED', resolvedBody: 'x {{OTHER}} {{SENDER_NAME}}' } }).reasons).toContain('unexpected_unresolved_token');
    expect(checkGmailEligibility({ ...base(), recipientEmail: null }).reasons).toContain('no_verified_recipient');
    expect(checkGmailEligibility({ ...base(), recipientEmail: 'not-an-email' }).reasons).toContain('recipient_not_valid_email');
    expect(checkGmailEligibility({ ...base(), featureEnabled: false }).eligible).toBe(false);
    expect(checkGmailEligibility({ ...base(), draftActionsEnabled: false }).reasons).toContain('gmail_draft_actions_disabled');
  });
  it('flags a reusable duplicate instead of failing', () => {
    const r = checkGmailEligibility({ ...base(), existingDraftForFingerprint: true });
    expect(r.eligible).toBe(false); expect(r.duplicateReusable).toBe(true);
  });
});

// --- Service (mock provider; fake store/uow) ---

const logger = pino({ level: 'silent' });
const cfg = (over: Partial<GmailConfig> = {}): GmailConfig => ({
  gmailAccount: ACCOUNT, senderName: 'Example Sender', featureEnabled: true, draftActionsEnabled: true, credentialsConfigured: true, maxPerDay: 20, minIntervalMs: 0, ...over,
});
interface Cap { transitions: string[]; completes: { id: string; patch: Partial<GmailDraftRecord> }[]; }
function fakeUow(cap: Cap, leadStatus = 'HUMAN_APPROVED'): GmailUnitOfWork {
  return {
    async transaction(fn) {
      return fn({
        leads: { async getById() { return { id: 'l1', status: leadStatus } as never; } } as never,
        leadService: { async transition(_id: string, to: string) { cap.transitions.push(to); } } as never,
        completeRun: async (id, patch) => { cap.completes.push({ id, patch }); },
        events: { async record() { /* noop */ } },
      });
    },
  };
}
function fakeStore(over: Partial<GmailStore> = {}): GmailStore {
  return {
    async draftsToday() { return 0; },
    async lastAttemptAt() { return null; },
    async existingByFingerprint() { return false; },
    async findReservedByFingerprint() { return null; },
    async reserveRun() { /* noop */ },
    ...over,
  };
}
const input = (over: Partial<GmailInput> = {}): GmailInput => ({
  leadId: 'l1', leadStatus: 'HUMAN_APPROVED',
  finalization: { id: 'fin1', resolvedBody: BODY, resolvedBodyHash: 'h', finalHumanDecision: 'APPROVED' },
  subject: 'Anregung', recipientEmail: RECIP, ...over,
});

describe('GmailDraftService (mock)', () => {
  it('creates a draft and advances the lead to DRAFT_CREATED', async () => {
    const cap: Cap = { transitions: [], completes: [] };
    const provider = new MockGmailDraftProvider(ACCOUNT);
    const svc = new GmailDraftService({ provider, store: fakeStore(), uow: fakeUow(cap), logger, config: cfg() });
    const r = await svc.createDraft(input(), 'run-1');
    expect(r.outcome).toBe('DRAFT_CREATED');
    expect(r.draftId).toBeTruthy();
    expect(provider.created).toHaveLength(1);
    expect(cap.transitions).toEqual(['DRAFT_CREATED']);
    expect(cap.completes.at(-1)?.patch.providerDraftId).toBeTruthy();
  });
  it('does not create a draft when the recipient is missing (NO_RECIPIENT)', async () => {
    const cap: Cap = { transitions: [], completes: [] };
    const provider = new MockGmailDraftProvider(ACCOUNT);
    const r = await new GmailDraftService({ provider, store: fakeStore(), uow: fakeUow(cap), logger, config: cfg() }).createDraft(input({ recipientEmail: null }), 'run-1');
    expect(r.outcome).toBe('NO_RECIPIENT');
    expect(provider.created).toHaveLength(0);
  });
  it('fails INVALID_TOKENS when the sender name is not configured', async () => {
    const cap: Cap = { transitions: [], completes: [] };
    const provider = new MockGmailDraftProvider(ACCOUNT);
    const r = await new GmailDraftService({ provider, store: fakeStore(), uow: fakeUow(cap), logger, config: cfg({ senderName: null }) }).createDraft(input(), 'run-1');
    expect(r.outcome).toBe('INVALID_TOKENS');
    expect(provider.created).toHaveLength(0);
  });
  it('fails ACCOUNT_MISMATCH when the authorized account differs', async () => {
    const cap: Cap = { transitions: [], completes: [] };
    const provider = new MockGmailDraftProvider('other@business.de'); // verify returns this email
    const r = await new GmailDraftService({ provider, store: fakeStore(), uow: fakeUow(cap), logger, config: cfg() }).createDraft(input(), 'run-1');
    expect(r.outcome).toBe('ACCOUNT_MISMATCH');
    expect(cap.transitions).toEqual(['NEEDS_MANUAL_REVIEW']);
    expect(provider.created).toHaveLength(0);
  });
  it('reuses an existing draft (DUPLICATE_REUSED), no new create', async () => {
    const cap: Cap = { transitions: [], completes: [] };
    const provider = new MockGmailDraftProvider(ACCOUNT);
    const r = await new GmailDraftService({ provider, store: fakeStore({ async existingByFingerprint() { return true; } }), uow: fakeUow(cap), logger, config: cfg() }).createDraft(input(), 'run-1');
    expect(r.outcome).toBe('DUPLICATE_REUSED');
    expect(provider.created).toHaveLength(0);
  });
  it('parks an uncertain prior attempt (reserved without draft id) for manual review', async () => {
    const cap: Cap = { transitions: [], completes: [] };
    const provider = new MockGmailDraftProvider(ACCOUNT);
    const reserved: GmailDraftRecord = { id: 'run-x', leadId: 'l1', finalizedEmailId: 'fin1', recipientEmail: RECIP, senderEmail: ACCOUNT, gmailAccount: ACCOUNT, provider: 'mock-gmail', providerDraftId: null, threadId: null, messageId: null, idempotencyFingerprint: 'fp', sourceEmailVersion: 'h', outcome: 'TRANSIENT_ERROR', errorClass: null, createdAt: new Date(), completedAt: null };
    const r = await new GmailDraftService({ provider, store: fakeStore({ async findReservedByFingerprint() { return reserved; } }), uow: fakeUow(cap), logger, config: cfg() }).createDraft(input(), 'run-1');
    expect(r.outcome).toBe('MANUAL_REVIEW_REQUIRED');
    expect(provider.created).toHaveLength(0);
  });
  it('rate-limited create stays retryable (no transition)', async () => {
    const cap: Cap = { transitions: [], completes: [] };
    const provider = new MockGmailDraftProvider(ACCOUNT, { create: { outcome: 'rate_limited', reason: '429' } });
    const r = await new GmailDraftService({ provider, store: fakeStore(), uow: fakeUow(cap), logger, config: cfg() }).createDraft(input(), 'run-1');
    expect(r.outcome).toBe('RATE_LIMITED');
    expect(cap.transitions).toEqual([]);
  });
  it('blocks on the per-day budget', async () => {
    const cap: Cap = { transitions: [], completes: [] };
    const provider = new MockGmailDraftProvider(ACCOUNT);
    const r = await new GmailDraftService({ provider, store: fakeStore({ async draftsToday() { return 20; } }), uow: fakeUow(cap), logger, config: cfg({ maxPerDay: 20 }) }).createDraft(input(), 'run-1');
    expect(r.outcome).toBe('BUDGET_BLOCKED');
  });
});
