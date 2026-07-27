import { describe, expect, it } from 'vitest';
import { type Logger } from 'pino';
import { OutreachService } from '../../src/domain/outreach/outreach-service.js';
import { runReplySync, type TrackedThread } from '../../src/domain/outreach/reply-sync.js';
import { HttpGmailThreadReader, type GmailHttpGet } from '../../src/integrations/gmail/http-reply-provider.js';
import { GMAIL_READONLY_SCOPE, type AccessTokenProvider } from '../../src/integrations/gmail/oauth.js';
import { type GmailTokenStore } from '../../src/integrations/gmail/token-store.js';
import { InMemoryOutreachStore } from '../support/outreach-memory.js';

/**
 * End-to-end reply sync driven by the REAL HttpGmailThreadReader (with a fake, recorded HTTP
 * transport — no network). This exercises the full live path: threads.get metadata → InboundMessage
 * → deterministic classifier → applyReply (status + follow-up cancellation + DNC). Mocks only.
 */

const TZ = 'Europe/Berlin';
const NOW = Date.parse('2026-07-22T12:00:00Z');
const OWN = ['outreach@agency.example'];
const SENT_AT = Date.parse('2026-07-20T09:00:00Z');

const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;
const tokens: AccessTokenProvider = { getAccessToken: async () => 'tok' };
const readonlyStore: GmailTokenStore = {
  load: async () => ({ refreshToken: 'r', accountEmail: OWN[0]!, scope: GMAIL_READONLY_SCOPE, obtainedAt: '2026-07-01T00:00:00Z' }),
  save: async () => {},
  exists: () => true,
};

function msg(over: { id: string; from: string; atMs: number; snippet?: string; headers?: { name: string; value: string }[] }) {
  return {
    id: over.id, threadId: 'thr-1', internalDate: String(over.atMs), snippet: over.snippet ?? '',
    payload: { headers: [{ name: 'From', value: over.from }, ...(over.headers ?? [])] },
  };
}

/** Build a reader over canned thread data, recording every path requested. */
function reader(threads: Record<string, unknown>, calls: string[] = []) {
  const httpGet: GmailHttpGet = async (path) => {
    calls.push(path);
    const id = decodeURIComponent(/threads\/([^?]+)/.exec(path)?.[1] ?? '');
    const json = threads[id];
    return json ? { status: 200, json: json as Record<string, unknown> } : { status: 404, json: null };
  };
  return { r: new HttpGmailThreadReader({ tokens, store: readonlyStore, logger, timeoutMs: 1000, httpGet }), calls };
}

async function seededRecord() {
  const store = new InMemoryOutreachStore();
  const svc = new OutreachService(store, { now: () => NOW });
  const rec = (await svc.track({ campaignId: 'c', leadId: 'l', contactEmail: 'prospect@clinic.example', timezone: TZ })).record!;
  await svc.recordMessage({ outreachRecordId: rec.id, messageType: 'INITIAL', sequenceStep: 0, subject: 's', body: 'b', gmailThreadId: 'thr-1', sentAt: new Date(SENT_AT) });
  const threads: TrackedThread[] = [{ outreachRecordId: rec.id, threadId: 'thr-1', lastOutboundAtMs: SENT_AT, handledMessageIds: [] }];
  return { store, svc, rec, threads };
}

const policy = { step1DelayDays: 3, step2DelayDays: 5, dueHourLocal: 9 };

describe('live reply sync via HttpGmailThreadReader', () => {
  it('detects an inbound reply and applies it', async () => {
    const { store, svc, rec, threads } = await seededRecord();
    const { r } = reader({ 'thr-1': { id: 'thr-1', messages: [
      msg({ id: 'reply-1', from: 'Prospect <prospect@clinic.example>', atMs: Date.parse('2026-07-21T10:00:00Z'), snippet: 'Interested — book a call' }),
    ] } });
    const report = await runReplySync({ reader: r, service: svc, threads, ownEmails: OWN });
    expect(report.readExternally).toBe(true);
    expect(report.repliesApplied).toHaveLength(1);
    expect(store.records.get(rec.id)?.status).toBe('REPLIED_POSITIVE');
  });

  it('excludes the account\'s own (self) messages', async () => {
    const { store, svc, rec, threads } = await seededRecord();
    const { r } = reader({ 'thr-1': { id: 'thr-1', messages: [
      msg({ id: 'self', from: 'Agency <outreach@agency.example>', atMs: Date.parse('2026-07-21T10:00:00Z'), snippet: 'our own follow-up' }),
    ] } });
    const report = await runReplySync({ reader: r, service: svc, threads, ownEmails: OWN });
    expect(report.repliesApplied).toHaveLength(0);
    expect(store.records.get(rec.id)?.status).toBe('DRAFT_READY');
  });

  it('excludes inbound messages at/older than the last outbound', async () => {
    const { svc, threads } = await seededRecord();
    const { r } = reader({ 'thr-1': { id: 'thr-1', messages: [
      msg({ id: 'old', from: 'Prospect <prospect@clinic.example>', atMs: SENT_AT - 60_000, snippet: 'older than our send' }),
      msg({ id: 'same', from: 'Prospect <prospect@clinic.example>', atMs: SENT_AT, snippet: 'exactly at our send' }),
    ] } });
    const report = await runReplySync({ reader: r, service: svc, threads, ownEmails: OWN });
    expect(report.repliesApplied).toHaveLength(0);
  });

  it('cancels pending follow-ups after a genuine reply', async () => {
    const { store, svc, rec, threads } = await seededRecord();
    await svc.scheduleFollowup(rec.id, 1, policy);
    expect(store.pendingFor(rec.id)).toHaveLength(1);
    const { r } = reader({ 'thr-1': { id: 'thr-1', messages: [
      msg({ id: 'reply-1', from: 'Prospect <prospect@clinic.example>', atMs: Date.parse('2026-07-21T10:00:00Z'), snippet: 'sounds good' }),
    ] } });
    await runReplySync({ reader: r, service: svc, threads, ownEmails: OWN });
    expect(store.pendingFor(rec.id)).toHaveLength(0);
  });

  it('marks unsubscribe as DO_NOT_CONTACT', async () => {
    const { store, svc, rec, threads } = await seededRecord();
    const { r } = reader({ 'thr-1': { id: 'thr-1', messages: [
      msg({ id: 'reply-1', from: 'Prospect <prospect@clinic.example>', atMs: Date.parse('2026-07-21T10:00:00Z'), snippet: 'Please unsubscribe me' }),
    ] } });
    await runReplySync({ reader: r, service: svc, threads, ownEmails: OWN });
    const updated = store.records.get(rec.id)!;
    expect(updated.status).toBe('UNSUBSCRIBED');
    expect(updated.doNotContact).toBe(true);
  });

  it('handles a bounce from mailer-daemon', async () => {
    const { store, svc, rec, threads } = await seededRecord();
    const { r } = reader({ 'thr-1': { id: 'thr-1', messages: [
      msg({ id: 'bounce-1', from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', atMs: Date.parse('2026-07-21T10:00:00Z'), snippet: 'Address not found', headers: [{ name: 'Content-Type', value: 'multipart/report; report-type=delivery-status' }] }),
    ] } });
    await runReplySync({ reader: r, service: svc, threads, ownEmails: OWN });
    expect(store.records.get(rec.id)?.status).toBe('BOUNCED');
  });

  it('never reads an untracked thread: only tracked thread ids are ever fetched', async () => {
    const { svc, threads } = await seededRecord();
    // Canned data exists for an UNTRACKED thread, but it must never be requested or applied.
    const { r, calls } = reader({
      'thr-1': { id: 'thr-1', messages: [] },
      'thr-untracked': { id: 'thr-untracked', messages: [
        msg({ id: 'x', from: 'Someone <someone@else.example>', atMs: Date.parse('2026-07-21T10:00:00Z'), snippet: 'should never be seen' }),
      ] },
    });
    const report = await runReplySync({ reader: r, service: svc, threads, ownEmails: OWN });
    expect(report.repliesApplied).toHaveLength(0);
    expect(calls.every((p) => p.includes('/threads/thr-1'))).toBe(true);
    expect(calls.some((p) => p.includes('thr-untracked'))).toBe(false);
  });
});
