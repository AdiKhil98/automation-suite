import { describe, expect, it, vi } from 'vitest';
import { type Logger } from 'pino';
import {
  HttpGmailThreadReader,
  liveReplyReadGate,
  type GmailHttpGet,
} from '../../src/integrations/gmail/http-reply-provider.js';
import { GMAIL_COMPOSE_SCOPE, GMAIL_READONLY_SCOPE, type AccessTokenProvider } from '../../src/integrations/gmail/oauth.js';
import { type GmailCredentials, type GmailTokenStore } from '../../src/integrations/gmail/token-store.js';

const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;
const tokens: AccessTokenProvider = { getAccessToken: async () => 'access-token-never-logged' };

function store(cred: GmailCredentials | null): GmailTokenStore {
  return { load: async () => cred, save: async () => {}, exists: () => cred !== null };
}

function readonlyCred(scope = GMAIL_READONLY_SCOPE): GmailCredentials {
  return { refreshToken: 'r', accountEmail: 'me@agency.example', scope, obtainedAt: '2026-07-01T00:00:00Z' };
}

/** A canned threads.get response keyed by thread id. Records every requested path. */
function fakeHttp(
  threads: Record<string, unknown>,
  calls: string[],
  status = 200,
): GmailHttpGet {
  return async (path) => {
    calls.push(path);
    const id = /threads\/([^?]+)/.exec(path)?.[1];
    const decoded = id ? decodeURIComponent(id) : '';
    const json = threads[decoded];
    if (!json) return { status: 404, json: null };
    return { status, json: json as Record<string, unknown> };
  };
}

const THREAD_THR1 = {
  id: 'thr-1',
  messages: [
    { id: 'self', threadId: 'thr-1', internalDate: '1600000000000', snippet: 'our outbound', payload: { headers: [{ name: 'From', value: 'Agency <outreach@agency.example>' }] } },
    {
      id: 'reply-1', threadId: 'thr-1', internalDate: '1600000600000', snippet: 'Interested — please book a call',
      payload: { headers: [
        { name: 'From', value: 'Dr Prospect <Prospect@Clinic.Example>' },
        { name: 'Content-Type', value: 'text/plain' },
        { name: 'List-Unsubscribe', value: '<mailto:x@clinic.example>' },
      ] },
    },
  ],
};

describe('HttpGmailThreadReader', () => {
  it('maps threads.get metadata into oldest-first InboundMessage[]', async () => {
    const calls: string[] = [];
    const reader = new HttpGmailThreadReader({ tokens, store: store(readonlyCred()), logger, timeoutMs: 1000, httpGet: fakeHttp({ 'thr-1': THREAD_THR1 }, calls) });
    const msgs = await reader.readThread('thr-1');
    expect(msgs.map((m) => m.messageId)).toEqual(['self', 'reply-1']);
    const reply = msgs[1]!;
    expect(reply.fromEmail).toBe('prospect@clinic.example'); // extracted from angle brackets + lowercased
    expect(reply.receivedAtMs).toBe(1_600_000_600_000);
    expect(reply.preview).toBe('Interested — please book a call');
    expect(reply.headers.contentType).toBe('text/plain');
    expect(reply.headers.hasListUnsubscribe).toBe(true);
    expect(reader.readsExternally).toBe(true);
  });

  it('issues exactly ONE read-only GET to threads/{id} — no list/search/q=', async () => {
    const calls: string[] = [];
    const reader = new HttpGmailThreadReader({ tokens, store: store(readonlyCred()), logger, timeoutMs: 1000, httpGet: fakeHttp({ 'thr-1': THREAD_THR1 }, calls) });
    await reader.readThread('thr-1');
    expect(calls).toHaveLength(1);
    const path = calls[0]!;
    // Exactly a single-thread GET: /threads/{id}?..., never a *.list or *.messages endpoint.
    expect(path).toMatch(/^\/gmail\/v1\/users\/me\/threads\/thr-1\?/);
    expect(path).toContain('format=metadata');
    expect(path).not.toContain('/messages');
    expect(path).not.toContain('q=');
    expect(path).not.toMatch(/threads\/list|\/threads\?/); // no mailbox-wide thread listing
  });

  it('fails closed (empty array) on a non-2xx status', async () => {
    const calls: string[] = [];
    const reader = new HttpGmailThreadReader({ tokens, store: store(readonlyCred()), logger, timeoutMs: 1000, httpGet: fakeHttp({ 'thr-1': THREAD_THR1 }, calls, 500) });
    expect(await reader.readThread('thr-1')).toEqual([]);
  });

  it('fails closed (empty array) when the transport throws', async () => {
    const reader = new HttpGmailThreadReader({ tokens, store: store(readonlyCred()), logger, timeoutMs: 1000, httpGet: async () => { throw new Error('network down'); } });
    expect(await reader.readThread('thr-1')).toEqual([]);
  });

  it('returns [] for an unknown/inaccessible thread id (never infers a reply from an error)', async () => {
    const calls: string[] = [];
    const reader = new HttpGmailThreadReader({ tokens, store: store(readonlyCred()), logger, timeoutMs: 1000, httpGet: fakeHttp({ 'thr-1': THREAD_THR1 }, calls) });
    expect(await reader.readThread('thr-unknown')).toEqual([]);
  });

  describe('verifyReadAccess (fail-closed scope guard)', () => {
    it('accepts a credential whose scope is EXACTLY gmail.readonly', async () => {
      const reader = new HttpGmailThreadReader({ tokens, store: store(readonlyCred()), logger, timeoutMs: 1000, httpGet: fakeHttp({}, []) });
      expect(await reader.verifyReadAccess()).toEqual({ ok: true });
    });

    it('rejects a compose/send scope', async () => {
      const reader = new HttpGmailThreadReader({ tokens, store: store(readonlyCred(GMAIL_COMPOSE_SCOPE)), logger, timeoutMs: 1000, httpGet: fakeHttp({}, []) });
      expect((await reader.verifyReadAccess()).ok).toBe(false);
    });

    it('rejects a mixed scope that also carries a write scope', async () => {
      const reader = new HttpGmailThreadReader({ tokens, store: store(readonlyCred(`${GMAIL_READONLY_SCOPE} ${GMAIL_COMPOSE_SCOPE}`)), logger, timeoutMs: 1000, httpGet: fakeHttp({}, []) });
      expect((await reader.verifyReadAccess()).ok).toBe(false);
    });

    it('rejects a missing credential', async () => {
      const reader = new HttpGmailThreadReader({ tokens, store: store(null), logger, timeoutMs: 1000, httpGet: fakeHttp({}, []) });
      const check = await reader.verifyReadAccess();
      expect(check.ok).toBe(false);
      expect(check.reason).toContain('gmail-read-auth');
    });
  });

  describe('liveReplyReadGate (two-gate fail-closed)', () => {
    it('rejects when GMAIL_REPLY_SYNC_ENABLED is false', () => {
      expect(liveReplyReadGate({ syncEnabled: false, confirmed: true }).ok).toBe(false);
    });
    it('rejects when --confirm-gmail-read is missing', () => {
      const g = liveReplyReadGate({ syncEnabled: true, confirmed: false });
      expect(g.ok).toBe(false);
      expect(g.reason).toContain('confirm-gmail-read');
    });
    it('allows only when both gates are satisfied', () => {
      expect(liveReplyReadGate({ syncEnabled: true, confirmed: true })).toEqual({ ok: true });
    });
  });

  it('exposes ZERO Gmail mutation methods (no send/draft/label/archive/delete/trash/modify path)', () => {
    const reader = new HttpGmailThreadReader({ tokens, store: store(readonlyCred()), logger, timeoutMs: 1000, httpGet: fakeHttp({}, []) });
    const names = new Set<string>();
    for (let o: object | null = reader; o && o !== Object.prototype; o = Object.getPrototypeOf(o) as object | null) {
      for (const n of Object.getOwnPropertyNames(o)) names.add(n);
    }
    const forbidden = /send|draft|label|archive|delete|trash|modify|insert|update|patch|post|create|remove/i;
    const offending = [...names].filter((n) => forbidden.test(n));
    expect(offending).toEqual([]);
    // The public surface is exactly the read-only contract.
    expect(typeof reader.readThread).toBe('function');
    expect(typeof reader.verifyReadAccess).toBe('function');
  });

  it('never issues a non-GET request: the transport signature has no method/body channel', async () => {
    // The provider depends on GmailHttpGet(path, token, timeoutMs) — there is structurally no
    // way to pass an HTTP method or body, so send/draft/label/delete cannot be expressed.
    const spy = vi.fn<GmailHttpGet>(async () => ({ status: 200, json: THREAD_THR1 as unknown as Record<string, unknown> }));
    const reader = new HttpGmailThreadReader({ tokens, store: store(readonlyCred()), logger, timeoutMs: 1000, httpGet: spy });
    await reader.readThread('thr-1');
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]).toHaveLength(3); // (path, token, timeoutMs) only
  });
});
