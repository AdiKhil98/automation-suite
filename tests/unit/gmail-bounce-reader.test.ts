import { describe, expect, it } from 'vitest';
import { type Logger } from 'pino';
import { type TrackedOutbound } from '../../src/domain/outreach/delivery.js';
import { HttpGmailBounceReader } from '../../src/integrations/gmail/http-bounce-reader.js';
import { MockGmailBounceReader } from '../../src/integrations/gmail/mock-bounce-reader.js';
import { type GmailHttpGet } from '../../src/integrations/gmail/http-reply-provider.js';
import { GMAIL_COMPOSE_SCOPE, GMAIL_READONLY_SCOPE, type AccessTokenProvider } from '../../src/integrations/gmail/oauth.js';
import { type GmailCredentials, type GmailTokenStore } from '../../src/integrations/gmail/token-store.js';
import { liveReplyReadGate, selectReplyReader } from '../../src/integrations/gmail/http-reply-provider.js';

const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;
const tokens: AccessTokenProvider = { getAccessToken: async () => 'access-token-never-logged' };

function store(cred: GmailCredentials | null): GmailTokenStore {
  return { load: async () => cred, save: async () => {}, exists: () => cred !== null };
}
function readonlyCred(scope = GMAIL_READONLY_SCOPE): GmailCredentials {
  return { refreshToken: 'r', accountEmail: 'me@agency.example', scope, obtainedAt: '2026-07-01T00:00:00Z' };
}
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

const OUTBOUND: TrackedOutbound = {
  outreachRecordId: 'rec-1', outreachMessageId: 'msg-1', gmailMessageId: 'gm-out-1',
  gmailThreadId: 'thr-out-1', contactEmail: 'prospect@clinic.example',
  sentAtMs: Date.parse('2026-07-20T09:00:00Z'), rfcMessageId: '<out-1@mail>',
};

const FULL_DSN = {
  id: 'dsn-1', threadId: 'thr-dsn-separate', internalDate: '1600000600000', snippet: 'Address rejected as likely unsolicited mail',
  payload: {
    headers: [
      { name: 'From', value: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>' },
      { name: 'Subject', value: 'Delivery Status Notification (Failure)' },
      { name: 'Content-Type', value: 'multipart/report; report-type=delivery-status' },
      { name: 'References', value: '<out-1@mail>' },
    ],
    parts: [
      { mimeType: 'text/plain', body: { data: b64('This is an automatically generated Delivery Status Notification.') } },
      { mimeType: 'message/delivery-status', body: { data: b64('Action: failed\nStatus: 5.7.1\nFinal-Recipient: rfc822; prospect@clinic.example\nDiagnostic-Code: smtp; 550 5.7.1 rejected') } },
      { mimeType: 'message/rfc822', headers: [{ name: 'Message-ID', value: '<out-1@mail>' }], body: { data: b64('Message-ID: <out-1@mail>\nSubject: original') } },
    ],
  },
};

/** Fake GET keyed by path shape; records every requested path. */
function fakeHttp(calls: string[]): GmailHttpGet {
  return async (path) => {
    calls.push(path);
    if (path.startsWith('/gmail/v1/users/me/messages?')) return { status: 200, json: { messages: [{ id: 'dsn-1' }] } };
    if (path.includes('/messages/dsn-1')) return { status: 200, json: FULL_DSN as unknown as Record<string, unknown> };
    return { status: 404, json: null };
  };
}

describe('HttpGmailBounceReader', () => {
  it('finds a DSN via a scoped search + full fetch and extracts the delivery-status + references', async () => {
    const calls: string[] = [];
    const reader = new HttpGmailBounceReader({ tokens, store: store(readonlyCred()), logger, timeoutMs: 1000, httpGet: fakeHttp(calls) });
    const [n] = await reader.findDeliveryNotifications({ outbounds: [OUTBOUND] });
    expect(n?.gmailMessageId).toBe('dsn-1');
    expect(n?.gmailThreadId).toBe('thr-dsn-separate'); // separate thread supported
    expect(n?.fromEmail).toBe('mailer-daemon@googlemail.com');
    expect(n?.deliveryStatusText).toContain('Status: 5.7.1');
    expect(n?.referencedMessageIds).toContain('<out-1@mail>'); // from References + embedded Message-ID
    expect(reader.readsExternally).toBe(true);
  });

  it('falls back to the text/plain body when no structured delivery-status part exists', async () => {
    const plainDsn = {
      id: 'dsn-1', threadId: 'thr-dsn-plain', internalDate: '1600000600000', snippet: 'Delivery failed',
      payload: {
        headers: [
          { name: 'From', value: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>' },
          { name: 'Subject', value: 'Delivery incomplete' },
          { name: 'Content-Type', value: 'text/plain' },
        ],
        parts: [
          { mimeType: 'text/plain', body: { data: b64('Your message to prospect@clinic.example was not delivered.\n550 5.7.1 rejected as likely unsolicited mail') } },
        ],
      },
    };
    const httpGet: GmailHttpGet = async (path) => {
      if (path.startsWith('/gmail/v1/users/me/messages?')) return { status: 200, json: { messages: [{ id: 'dsn-1' }] } };
      return { status: 200, json: plainDsn as unknown as Record<string, unknown> };
    };
    const reader = new HttpGmailBounceReader({ tokens, store: store(readonlyCred()), logger, timeoutMs: 1000, httpGet });
    const [n] = await reader.findDeliveryNotifications({ outbounds: [OUTBOUND] });
    expect(n?.deliveryStatusText).toContain('550 5.7.1'); // text/plain used as fallback
  });

  it('issues only GETs to messages list + messages get — no mutation endpoints', async () => {
    const calls: string[] = [];
    const reader = new HttpGmailBounceReader({ tokens, store: store(readonlyCred()), logger, timeoutMs: 1000, httpGet: fakeHttp(calls) });
    await reader.findDeliveryNotifications({ outbounds: [OUTBOUND] });
    expect(calls.length).toBeGreaterThan(0);
    for (const p of calls) {
      expect(p.startsWith('/gmail/v1/users/me/messages')).toBe(true);
      expect(p).not.toMatch(/send|draft|trash|modify|labels|batchModify/i);
    }
    // The scoped search connects to a tracked recipient (never a blanket mailbox scan).
    const listCall = calls.find((p) => p.startsWith('/gmail/v1/users/me/messages?'))!;
    expect(decodeURIComponent(listCall)).toContain('prospect@clinic.example');
  });

  it('does not search the mailbox at all when there are no tracked recipients', async () => {
    const calls: string[] = [];
    const reader = new HttpGmailBounceReader({ tokens, store: store(readonlyCred()), logger, timeoutMs: 1000, httpGet: fakeHttp(calls) });
    expect(await reader.findDeliveryNotifications({ outbounds: [] })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('fails closed (empty) when the transport throws', async () => {
    const reader = new HttpGmailBounceReader({ tokens, store: store(readonlyCred()), logger, timeoutMs: 1000, httpGet: async () => { throw new Error('network down'); } });
    expect(await reader.findDeliveryNotifications({ outbounds: [OUTBOUND] })).toEqual([]);
  });

  describe('verifyReadAccess (fail-closed scope guard)', () => {
    it('accepts a credential whose scope is EXACTLY gmail.readonly', async () => {
      const reader = new HttpGmailBounceReader({ tokens, store: store(readonlyCred()), logger, timeoutMs: 1000, httpGet: fakeHttp([]) });
      expect(await reader.verifyReadAccess()).toEqual({ ok: true });
    });
    it('rejects a compose/send scope', async () => {
      const reader = new HttpGmailBounceReader({ tokens, store: store(readonlyCred(GMAIL_COMPOSE_SCOPE)), logger, timeoutMs: 1000, httpGet: fakeHttp([]) });
      expect((await reader.verifyReadAccess()).ok).toBe(false);
    });
    it('rejects a missing credential', async () => {
      const reader = new HttpGmailBounceReader({ tokens, store: store(null), logger, timeoutMs: 1000, httpGet: fakeHttp([]) });
      expect((await reader.verifyReadAccess()).ok).toBe(false);
    });
  });

  it('exposes ZERO Gmail mutation methods (no send/draft/label/archive/delete/trash/modify path)', () => {
    const reader = new HttpGmailBounceReader({ tokens, store: store(readonlyCred()), logger, timeoutMs: 1000, httpGet: fakeHttp([]) });
    const names = new Set<string>();
    for (let o: object | null = reader; o && o !== Object.prototype; o = Object.getPrototypeOf(o) as object | null) {
      for (const n of Object.getOwnPropertyNames(o)) names.add(n);
    }
    const forbidden = /send|draft|label|archive|delete|trash|modify|insert|update|patch|remove/i;
    expect([...names].filter((n) => forbidden.test(n))).toEqual([]);
  });

  it('never issues a non-GET request: the transport signature has no method/body channel', async () => {
    const calls: string[] = [];
    const spy: GmailHttpGet = async (...args) => { calls.push(String(args.length)); return fakeHttp([])(...args); };
    const reader = new HttpGmailBounceReader({ tokens, store: store(readonlyCred()), logger, timeoutMs: 1000, httpGet: spy });
    await reader.findDeliveryNotifications({ outbounds: [OUTBOUND] });
    // Every call passed exactly (path, token, timeoutMs) — there is no way to express a method or body.
    expect(calls.every((n) => n === '3')).toBe(true);
  });
});

describe('MockGmailBounceReader', () => {
  it('is offline and exposes no mutation methods', () => {
    const reader = new MockGmailBounceReader();
    expect(reader.readsExternally).toBe(false);
    const names = new Set<string>();
    for (let o: object | null = reader; o && o !== Object.prototype; o = Object.getPrototypeOf(o) as object | null) {
      for (const n of Object.getOwnPropertyNames(o)) names.add(n);
    }
    const forbidden = /send|draft|label|archive|delete|trash|modify|insert|update|patch|remove/i;
    expect([...names].filter((n) => forbidden.test(n))).toEqual([]);
  });
});

describe('reconcile reader selection is fail-closed (never mock on a live intent)', () => {
  it('selects LIVE the moment a live intent is present, so a failed guard throws instead of using mock', () => {
    // A live intent (sync enabled) with no --confirm-gmail-read: selection is LIVE (not mock)...
    expect(selectReplyReader({ syncEnabled: true, confirmed: false, mock: false })).toEqual({ kind: 'live' });
    // ...and the live gate then refuses — the command throws rather than downgrading to mock.
    expect(liveReplyReadGate({ syncEnabled: true, confirmed: false }).ok).toBe(false);
  });
  it('refuses --mock combined with a live intent, and refuses selecting neither', () => {
    expect(selectReplyReader({ syncEnabled: true, confirmed: false, mock: true }).kind).toBe('refuse');
    expect(selectReplyReader({ syncEnabled: false, confirmed: false, mock: false }).kind).toBe('refuse');
  });
});
