import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { buildMessagesTab, type MessageRowView } from '../../src/domain/outreach/sheet-sync.js';
import { messageContentHash } from '../../src/domain/outreach/records.js';
import { DEFAULT_SEQUENCE_POLICY } from '../../src/domain/outreach/followups.js';
import {
  evaluateSmokeSendGuards,
  OutreachSmokeSendService,
  verifyDraftEnvelope,
  type RecordSendInput,
  type SmokeContext,
  type SmokeGuardConfig,
  type SmokeSendRequest,
  type SmokeSendStore,
} from '../../src/domain/outreach/smoke-send.js';
import { MockGmailDraftProvider } from '../../src/integrations/gmail/mock-gmail.js';
import { MockSendProvider } from '../../src/integrations/send/mock-send.js';
import { type DraftInspectionResult } from '../../src/integrations/send/provider.js';

const SENDER = 'admin@scaleflow.it.com';
const RECIPIENT = 'kheadi10@gmail.com';
const SUBJECT = 'Automation Suite tracked-send test';
const BODY = 'Hi Adi,\n\nThis is the controlled Automation Suite send test.\n\nAdi\nScaleFlow';
const HASH = messageContentHash(SUBJECT, BODY);
const NOW = Date.UTC(2026, 6, 30, 12, 0, 0);

const logger = pino({ level: 'silent' });

function config(over: Partial<SmokeGuardConfig> = {}): SmokeGuardConfig {
  return {
    smokeTestEnabled: true,
    sendingEnabled: true,
    outboundActionsEnabled: true,
    dryRun: false,
    providerIsHttp: true,
    sender: SENDER,
    allowedRecipient: RECIPIENT,
    approvalTtlMs: 60 * 60_000,
    ...over,
  };
}

function request(over: Partial<SmokeSendRequest> = {}): SmokeSendRequest {
  return {
    recordId: 'rec-1',
    confirmPhase17b: true,
    sender: SENDER,
    recipient: RECIPIENT,
    recipients: [RECIPIENT],
    cc: [],
    bcc: [],
    ...over,
  };
}

function context(over: { record?: Partial<SmokeContext['record']>; message?: Partial<NonNullable<SmokeContext['message']>> | null; priorSuccessfulSend?: boolean } = {}): SmokeContext {
  const message =
    over.message === null
      ? null
      : {
          id: 'msg-1',
          messageType: 'INITIAL' as const,
          sequenceStep: 0,
          subject: SUBJECT,
          body: BODY,
          contentHash: HASH,
          approvedAt: new Date(NOW - 5 * 60_000),
          sentAt: null,
          gmailMessageId: null,
          gmailThreadId: null,
          ...over.message,
        };
  return {
    record: {
      id: 'rec-1',
      status: 'APPROVED_TO_SEND',
      contactEmail: RECIPIENT,
      doNotContact: false,
      timezone: 'UTC',
      campaignId: 'camp-1',
      leadId: 'lead-1',
      ...over.record,
    },
    message,
    priorSuccessfulSend: over.priorSuccessfulSend ?? false,
  };
}

function goodDraft(): DraftInspectionResult {
  return {
    outcome: 'ok',
    envelope: { fromName: 'ScaleFlow', fromEmail: SENDER, to: [RECIPIENT], cc: [], bcc: [], replyTo: null, subject: SUBJECT, body: BODY, attachmentCount: 0 },
    providerDraftId: 'mock-draft-x',
    providerMessageId: 'pm-1',
    providerThreadId: 'pt-1',
  };
}

class FakeStore implements SmokeSendStore {
  public loaded: SmokeContext | null;
  public recorded: RecordSendInput[] = [];
  public throwOnRecord = false;
  constructor(ctx: SmokeContext | null) {
    this.loaded = ctx;
  }
  load(_recordId: string): Promise<SmokeContext | null> {
    return Promise.resolve(this.loaded);
  }
  recordSend(input: RecordSendInput): Promise<void> {
    if (this.throwOnRecord) return Promise.reject(new Error('db_write_failed'));
    this.recorded.push(input);
    return Promise.resolve();
  }
}

function buildService(store: SmokeSendStore, over: Partial<SmokeGuardConfig> = {}, sendScript: ConstructorParameters<typeof MockSendProvider>[0] = { account: { ok: true, email: SENDER }, draft: goodDraft(), send: { outcome: 'ok', ref: { providerMessageId: 'pm-1', providerThreadId: 'pt-1' } } }): { service: OutreachSmokeSendService; send: MockSendProvider; draft: MockGmailDraftProvider } {
  const draft = new MockGmailDraftProvider(SENDER);
  const send = new MockSendProvider(sendScript);
  const service = new OutreachSmokeSendService({
    draftProvider: draft,
    sendProvider: send,
    store,
    config: config(over),
    senderName: 'ScaleFlow',
    sequencePolicy: DEFAULT_SEQUENCE_POLICY,
    logger,
    now: () => NOW,
  });
  return { service, send, draft };
}

describe('evaluateSmokeSendGuards (pure)', () => {
  it('passes with a fully valid setup', () => {
    const r = evaluateSmokeSendGuards(config(), request(), context(), NOW);
    expect(r.ok).toBe(true);
  });

  it('rejects a wrong sender', () => {
    const r = evaluateSmokeSendGuards(config(), request({ sender: 'someone@else.com' }), context(), NOW);
    expect(r).toMatchObject({ ok: false, outcome: 'SENDER_MISMATCH' });
  });

  it('rejects a wrong recipient (request)', () => {
    const r = evaluateSmokeSendGuards(config(), request({ recipient: 'evil@nope.com', recipients: ['evil@nope.com'] }), context(), NOW);
    expect(r).toMatchObject({ ok: false, outcome: 'RECIPIENT_NOT_ALLOWLISTED' });
  });

  it('rejects when the tracked record contact is not the allowlisted address', () => {
    const r = evaluateSmokeSendGuards(config(), request(), context({ record: { contactEmail: 'other@x.com' } }), NOW);
    expect(r).toMatchObject({ ok: false, outcome: 'RECIPIENT_NOT_ALLOWLISTED' });
  });

  it('rejects a missing confirmation flag', () => {
    const r = evaluateSmokeSendGuards(config(), request({ confirmPhase17b: false }), context(), NOW);
    expect(r).toMatchObject({ ok: false, outcome: 'CONFIRMATION_MISSING' });
  });

  it.each([
    ['smokeTestEnabled', 'SMOKE_TEST_DISABLED'],
    ['sendingEnabled', 'SENDING_DISABLED'],
    ['outboundActionsEnabled', 'OUTBOUND_DISABLED'],
  ] as const)('rejects when %s is false', (flag, outcome) => {
    const r = evaluateSmokeSendGuards(config({ [flag]: false } as Partial<SmokeGuardConfig>), request(), context(), NOW);
    expect(r).toMatchObject({ ok: false, outcome });
  });

  it('rejects when DRY_RUN is active', () => {
    const r = evaluateSmokeSendGuards(config({ dryRun: true }), request(), context(), NOW);
    expect(r).toMatchObject({ ok: false, outcome: 'DRY_RUN_ACTIVE' });
  });

  it('rejects when the provider is not http (mock can never send)', () => {
    const r = evaluateSmokeSendGuards(config({ providerIsHttp: false }), request(), context(), NOW);
    expect(r).toMatchObject({ ok: false, outcome: 'PROVIDER_NOT_HTTP' });
  });

  it('rejects a duplicate send (message already sent)', () => {
    const r = evaluateSmokeSendGuards(config(), request(), context({ message: { sentAt: new Date(NOW - 1000), gmailMessageId: 'pm-old' } }), NOW);
    expect(r).toMatchObject({ ok: false, outcome: 'ALREADY_SENT' });
  });

  it('rejects a duplicate send (prior successful send on the record)', () => {
    const r = evaluateSmokeSendGuards(config(), request(), context({ priorSuccessfulSend: true }), NOW);
    expect(r).toMatchObject({ ok: false, outcome: 'ALREADY_SENT' });
  });

  it('rejects an expired approval', () => {
    const r = evaluateSmokeSendGuards(config(), request(), context({ message: { approvedAt: new Date(NOW - 2 * 60 * 60_000) } }), NOW);
    expect(r).toMatchObject({ ok: false, outcome: 'APPROVAL_EXPIRED' });
  });

  it('rejects a missing approval', () => {
    const r = evaluateSmokeSendGuards(config(), request(), context({ message: { approvedAt: null } }), NOW);
    expect(r).toMatchObject({ ok: false, outcome: 'APPROVAL_MISSING' });
  });

  it('requires the exact stored subject/body hash', () => {
    const r = evaluateSmokeSendGuards(config(), request(), context({ message: { contentHash: 'deadbeef' } }), NOW);
    expect(r).toMatchObject({ ok: false, outcome: 'CONTENT_HASH_MISMATCH' });
  });

  it('enforces a single-recipient cap (no bulk)', () => {
    const r = evaluateSmokeSendGuards(config(), request({ recipients: [RECIPIENT, 'second@extra.com'] }), context(), NOW);
    expect(r).toMatchObject({ ok: false, outcome: 'TOO_MANY_RECIPIENTS' });
  });

  it('rejects any Cc/Bcc', () => {
    const r = evaluateSmokeSendGuards(config(), request({ cc: ['cc@x.com'] }), context(), NOW);
    expect(r).toMatchObject({ ok: false, outcome: 'CC_BCC_NOT_ALLOWED' });
  });

  it('rejects a record that is not APPROVED_TO_SEND', () => {
    const r = evaluateSmokeSendGuards(config(), request(), context({ record: { status: 'AWAITING_APPROVAL' } }), NOW);
    expect(r).toMatchObject({ ok: false, outcome: 'RECORD_NOT_APPROVED' });
  });

  it('rejects a do-not-contact record', () => {
    const r = evaluateSmokeSendGuards(config(), request(), context({ record: { doNotContact: true } }), NOW);
    expect(r).toMatchObject({ ok: false, outcome: 'DO_NOT_CONTACT' });
  });

  it('rejects a missing INITIAL step-0 message', () => {
    const r = evaluateSmokeSendGuards(config(), request(), context({ message: null }), NOW);
    expect(r).toMatchObject({ ok: false, outcome: 'MESSAGE_MISSING' });
  });
});

describe('verifyDraftEnvelope', () => {
  const base = { fromEmail: SENDER, to: [RECIPIENT], cc: [], bcc: [], subject: SUBJECT, body: BODY, attachmentCount: 0 };
  const expected = { sender: SENDER, recipient: RECIPIENT, subject: SUBJECT, body: BODY };
  it('accepts a matching envelope', () => {
    expect(verifyDraftEnvelope(base, expected)).toBeNull();
  });
  it('rejects a Cc', () => {
    expect(verifyDraftEnvelope({ ...base, cc: ['x@y.com'] }, expected)).toBe('draft has Cc/Bcc');
  });
  it('rejects attachments', () => {
    expect(verifyDraftEnvelope({ ...base, attachmentCount: 1 }, expected)).toBe('draft has attachments');
  });
  it('rejects a recipient mismatch', () => {
    expect(verifyDraftEnvelope({ ...base, to: ['x@y.com'] }, expected)).toBe('draft recipient mismatch');
  });
});

describe('OutreachSmokeSendService.send', () => {
  it('sends and persists message + thread ids on success', async () => {
    const store = new FakeStore(context());
    const { service, send, draft } = buildService(store);
    const result = await service.send(request());
    expect(result.outcome).toBe('SENT');
    expect(result.providerMessageId).toBe('pm-1');
    expect(result.providerThreadId).toBe('pt-1');
    expect(send.sent).toHaveLength(1);
    expect(draft.created).toHaveLength(1);
    expect(store.recorded).toHaveLength(1);
    const rec = store.recorded[0]!;
    expect(rec.gmailMessageId).toBe('pm-1');
    expect(rec.gmailThreadId).toBe('pt-1');
    expect(rec.fromStatus).toBe('APPROVED_TO_SEND');
  });

  it('creates a follow-up (step 1) but never sends it', async () => {
    const store = new FakeStore(context());
    const { service, send } = buildService(store);
    await service.send(request());
    const rec = store.recorded[0]!;
    expect(rec.followup.step).toBe(1);
    expect(rec.followup.dueAt.getTime()).toBeGreaterThan(NOW);
    // Exactly one dispatch happened — the follow-up is tracking only.
    expect(send.sent).toHaveLength(1);
  });

  it('never auto-retries when persistence fails after a confirmed send', async () => {
    const store = new FakeStore(context());
    store.throwOnRecord = true;
    const { service, send } = buildService(store);
    const result = await service.send(request());
    expect(result.outcome).toBe('PERSISTENCE_FAILED_AFTER_SEND');
    expect(result.providerMessageId).toBe('pm-1');
    expect(result.recoveryCommand).toContain('outreach-smoke-reconcile');
    // Dispatched exactly once; no retry.
    expect(send.sent).toHaveLength(1);
  });

  it('does not touch the provider when a local guard fails', async () => {
    const store = new FakeStore(context());
    const { service, send, draft } = buildService(store, { sendingEnabled: false });
    const result = await service.send(request());
    expect(result.outcome).toBe('SENDING_DISABLED');
    expect(send.sent).toHaveLength(0);
    expect(send.verified).toHaveLength(0);
    expect(draft.created).toHaveLength(0);
  });

  it('fails closed when the authenticated account is not the exact sender', async () => {
    const store = new FakeStore(context());
    const { service, send } = buildService(store, {}, { account: { ok: true, email: 'someone@else.com' }, draft: goodDraft(), send: { outcome: 'ok', ref: { providerMessageId: 'pm-1', providerThreadId: 'pt-1' } } });
    const result = await service.send(request());
    expect(result.outcome).toBe('ACCOUNT_VERIFICATION_FAILED');
    expect(send.sent).toHaveLength(0);
  });

  it('fails closed when the created draft envelope does not match (e.g. a Cc appeared)', async () => {
    const store = new FakeStore(context());
    const badDraft: DraftInspectionResult = { ...goodDraft(), outcome: 'ok', envelope: { fromName: 'ScaleFlow', fromEmail: SENDER, to: [RECIPIENT], cc: ['sneaky@x.com'], bcc: [], replyTo: null, subject: SUBJECT, body: BODY, attachmentCount: 0 } };
    const { service, send } = buildService(store, {}, { account: { ok: true, email: SENDER }, draft: badDraft, send: { outcome: 'ok', ref: { providerMessageId: 'pm-1', providerThreadId: 'pt-1' } } });
    const result = await service.send(request());
    expect(result.outcome).toBe('DRAFT_VERIFICATION_FAILED');
    expect(send.sent).toHaveLength(0);
  });

  it('records an unknown outcome without retrying', async () => {
    const store = new FakeStore(context());
    const { service, send } = buildService(store, {}, { account: { ok: true, email: SENDER }, draft: goodDraft(), send: { outcome: 'unknown', reason: 'timeout' } });
    const result = await service.send(request());
    expect(result.outcome).toBe('SEND_OUTCOME_UNKNOWN');
    expect(result.recoveryCommand).toContain('outreach-smoke-reconcile');
    expect(send.sent).toHaveLength(1);
    expect(store.recorded).toHaveLength(0);
  });

  it('exposes no bulk / batch send path', () => {
    const names = Object.getOwnPropertyNames(OutreachSmokeSendService.prototype);
    expect(names).toContain('send');
    for (const n of names) {
      expect(n.toLowerCase()).not.toMatch(/bulk|batch|all|many|each/);
    }
  });
});

describe('sheet projection includes the sent message', () => {
  it('projects a sent INITIAL message into the Messages tab', () => {
    const rows: MessageRowView[] = [
      {
        messageId: 'msg-1',
        business: 'Phase 17B Smoke Test Lead (synthetic, internal)',
        contactEmail: RECIPIENT,
        campaign: 'Phase 17B Smoke Test',
        messageType: 'INITIAL',
        sequenceStep: 0,
        subject: SUBJECT,
        contentHash: HASH,
        approvedAt: new Date(NOW - 5 * 60_000),
        sentAt: new Date(NOW),
        gmailMessageId: 'pm-1',
        gmailThreadId: 'pt-1',
      },
    ];
    const tab = buildMessagesTab(rows);
    expect(tab.rows).toHaveLength(1);
    expect(tab.rows[0]!.rowId).toBe('message:msg-1');
    // The exact body is never dumped; the sheet references the version by content hash.
    expect(tab.rows[0]!.cells).toContain(HASH);
    expect(tab.rows[0]!.cells).toContain('pm-1');
    expect(tab.rows[0]!.cells).not.toContain(BODY);
  });
});

// A tiny sanity check that vi is available for potential spy-based assertions.
it('test harness sanity', () => {
  expect(vi).toBeDefined();
});
