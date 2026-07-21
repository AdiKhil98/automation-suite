import { describe, expect, it } from 'vitest';
import { buildRawMessage } from '../../src/domain/gmail/mime.js';
import { parseKnownGmailDraft } from '../../src/integrations/send/gmail-draft-parser.js';
import { HttpGmailReadOnlyVerifier, HttpGmailSendProvider, type GmailHttpRequest, type GmailHttpResponse, type GmailHttpTransport } from '../../src/integrations/send/http-gmail-send.js';

const ACCOUNT = 'sender@example.invalid';
const RECIPIENT = 'contact@example.invalid';
const DRAFT_ID = 'draft-example';
const MESSAGE_ID = 'message-example';
const THREAD_ID = 'thread-example';
const raw = buildRawMessage({ fromName: 'Example Sender', fromEmail: ACCOUNT, toEmail: RECIPIENT,
  subject: 'Fictional subject', body: 'Fictional plain-text body' });

class FakeTransport implements GmailHttpTransport {
  readonly requests: GmailHttpRequest[] = [];
  constructor(private readonly responses: (GmailHttpResponse | Error)[]) {}
  async request(input: GmailHttpRequest): Promise<GmailHttpResponse> {
    this.requests.push(input);
    const next = this.responses.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error('no_fake_response');
    return next;
  }
}

function draftBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ id: DRAFT_ID, message: { id: MESSAGE_ID, threadId: THREAD_ID,
    labelIds: ['DRAFT'], raw, ...overrides } });
}
function provider(responses: (GmailHttpResponse | Error)[]) {
  const transport = new FakeTransport(responses);
  const instance = new HttpGmailSendProvider({ tokens: { async getAccessToken() { return 'fictional-access-token'; } },
    timeoutMs: 5000, transport });
  return { instance, transport };
}

describe('HttpGmailSendProvider allowlist (mock transport only)', () => {
  it('exposes a structurally read-only verifier with no send method', async () => {
    const transport = new FakeTransport([{ status: 200, body: JSON.stringify({ emailAddress: ACCOUNT }) },
      { status: 200, body: draftBody() }]);
    const verifier = new HttpGmailReadOnlyVerifier({ tokens: { async getAccessToken() { return 'fictional-access-token'; } }, timeoutMs: 5000, transport });
    expect('sendExistingDraft' in verifier).toBe(false);
    expect((await verifier.verifyAccount(ACCOUNT)).ok).toBe(true);
    expect((await verifier.getKnownDraft(DRAFT_ID)).outcome).toBe('ok');
    expect(transport.requests.every((r) => r.method === 'GET' && r.body === null)).toBe(true);
  });
  it('uses only profile, one known drafts.get, and drafts.send with an id-only body', async () => {
    const { instance, transport } = provider([
      { status: 200, body: JSON.stringify({ emailAddress: ACCOUNT }) },
      { status: 200, body: draftBody() },
      { status: 200, body: JSON.stringify({ id: MESSAGE_ID, threadId: THREAD_ID }) },
    ]);
    expect(await instance.verifyAccount(ACCOUNT)).toEqual({ ok: true, email: ACCOUNT });
    const inspected = await instance.getKnownDraft(DRAFT_ID);
    expect(inspected.outcome).toBe('ok');
    expect(await instance.sendExistingDraft(DRAFT_ID)).toEqual({ outcome: 'ok', ref: {
      providerMessageId: MESSAGE_ID, providerThreadId: THREAD_ID } });
    expect(transport.requests.map((r) => [r.method, r.url])).toEqual([
      ['GET', 'https://gmail.googleapis.com/gmail/v1/users/me/profile'],
      ['GET', `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${DRAFT_ID}?format=raw`],
      ['POST', 'https://gmail.googleapis.com/gmail/v1/users/me/drafts/send'],
    ]);
    expect(transport.requests[2]?.body).toBe(JSON.stringify({ id: DRAFT_ID }));
    expect(transport.requests[2]?.body).not.toContain('raw');
    expect(transport.requests[2]?.body).not.toContain('message');
  });

  it('fails closed on mismatched identity, non-draft state, Cc/Bcc, attachments, and multipart MIME', async () => {
    expect(() => parseKnownGmailDraft(JSON.parse(draftBody()), 'another-draft')).toThrow('draft_identity_mismatch');
    expect(() => parseKnownGmailDraft(JSON.parse(draftBody({ labelIds: ['SENT'] })), DRAFT_ID)).toThrow('message_not_in_draft_state');
    const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const withCc = Buffer.from(decoded.replace('Subject:', 'Cc: copy@example.invalid\r\nSubject:')).toString('base64url');
    expect(() => parseKnownGmailDraft(JSON.parse(draftBody({ raw: withCc })), DRAFT_ID)).toThrow('unexpected_cc');
    const multipart = Buffer.from(decoded.replace(/Content-Type: text\/plain[^\r\n]*/i, 'Content-Type: multipart/mixed; boundary=x')).toString('base64url');
    expect(() => parseKnownGmailDraft(JSON.parse(draftBody({ raw: multipart })), DRAFT_ID)).toThrow('unsupported_mime_structure');
    const attachment = Buffer.from(decoded.replace('Content-Transfer-Encoding:', 'Content-Disposition: attachment; filename="x.txt"\r\nContent-Transfer-Encoding:')).toString('base64url');
    expect(() => parseKnownGmailDraft(JSON.parse(draftBody({ raw: attachment })), DRAFT_ID)).toThrow('attachment_not_allowed');
  });

  it('normalizes one Reply-To and rejects unexpected, duplicate, multiple, or malformed values', () => {
    const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const encoded = (header: string) => Buffer.from(decoded.replace('Subject:', `${header}\r\nSubject:`)).toString('base64url');
    expect(parseKnownGmailDraft(JSON.parse(draftBody({ raw: encoded('Reply-To: Replies@Example.Invalid') })), DRAFT_ID).envelope.replyTo)
      .toBe('replies@example.invalid');
    expect(() => parseKnownGmailDraft(JSON.parse(draftBody({ raw: encoded('Reply-To: one@example.invalid\r\nReply-To: two@example.invalid') })), DRAFT_ID))
      .toThrow('duplicate_reply-to_header');
    expect(() => parseKnownGmailDraft(JSON.parse(draftBody({ raw: encoded('Reply-To: one@example.invalid, two@example.invalid') })), DRAFT_ID))
      .toThrow('multiple_reply-to_addresses');
    expect(() => parseKnownGmailDraft(JSON.parse(draftBody({ raw: encoded('Reply-To: not-an-address') })), DRAFT_ID)).toThrow('invalid_address');
  });

  it('classifies auth, rate limit, definitive rejection, timeout/network, 5xx and malformed success honestly', async () => {
    for (const [status, outcome] of [[401, 'auth_error'], [429, 'rate_limited'], [400, 'definitive_failure'], [503, 'unknown']] as const) {
      const { instance } = provider([{ status, body: '{}' }]);
      expect((await instance.sendExistingDraft(DRAFT_ID)).outcome).toBe(outcome);
    }
    const timeout = provider([new Error('gmail_request_timeout')]);
    expect((await timeout.instance.sendExistingDraft(DRAFT_ID)).outcome).toBe('unknown');
    const malformed = provider([{ status: 200, body: '{}' }]);
    expect((await malformed.instance.sendExistingDraft(DRAFT_ID)).outcome).toBe('unknown');
    const auth = new HttpGmailSendProvider({ tokens: { async getAccessToken() { throw new Error('fictional_auth_failure'); } },
      timeoutMs: 5000, transport: new FakeTransport([]) });
    expect((await auth.sendExistingDraft(DRAFT_ID)).outcome).toBe('auth_error');
  });
});
