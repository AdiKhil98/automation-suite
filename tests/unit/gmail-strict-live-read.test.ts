import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MockGmailThreadReader } from '../../src/integrations/gmail/mock-reply-provider.js';
import { MockGmailBounceReader } from '../../src/integrations/gmail/mock-bounce-reader.js';
import {
  classifyHttpReadFailure,
  GmailReadFailureLog,
  summarizeGmailReadFailures,
} from '../../src/integrations/gmail/read-failure.js';
import { enforceStrictLiveRead } from '../../src/cli/commands/outreach.js';
import { runReplySync } from '../../src/domain/outreach/reply-sync.js';
import { type OutreachService } from '../../src/domain/outreach/outreach-service.js';
import { AppError } from '../../src/utils/errors.js';

/**
 * Strict live-read mode. The point is to distinguish two states that otherwise look identical at
 * the return value: "I read the inbox and there was nothing new" and "I could not read the inbox".
 * Follow-up automation may act on the first and must never act on the second.
 *
 * Nothing here performs network access — read failures are seeded into the mock readers, which
 * reproduce the live readers' contract exactly: still return empty, but record the failure.
 */

const UNIT = readFileSync(
  new URL('../../deploy/systemd/automation-suite-followups.service', import.meta.url),
  'utf8',
);
const DIRECTIVES = UNIT.split('\n').filter((l) => !l.trimStart().startsWith('#') && l.trim() !== '');

/** Captures applied replies without a database. */
function spyService(): { svc: OutreachService; applied: string[] } {
  const applied: string[] = [];
  const svc = {
    async applyReply(input: { gmailMessageId: string }) {
      applied.push(input.gmailMessageId);
      return {} as never;
    },
  } as unknown as OutreachService;
  return { svc, applied };
}

const thread = (outreachRecordId: string, threadId: string) => ({
  outreachRecordId, threadId, lastOutboundAtMs: 1_000, handledMessageIds: [] as string[],
});

const inbound = (messageId: string, atMs = 5_000) => ({
  messageId, threadId: 't', fromEmail: 'prospect@clinic.example', receivedAtMs: atMs,
  preview: 'sounds good, tell me more',
  headers: { fromEmail: 'prospect@clinic.example', autoSubmitted: null, contentType: 'text/plain', hasListUnsubscribe: false },
});

describe('strict live read — success paths stay success', () => {
  it('successful read with NO reply records no failure (exit 0)', async () => {
    const reader = new MockGmailThreadReader();
    reader.seedThread('t1', []);
    const { svc, applied } = spyService();
    const report = await runReplySync({ reader, service: svc, threads: [thread('rec-1', 't1')], ownEmails: ['me@x.test'] });

    expect(report.repliesApplied).toEqual([]);
    expect(applied).toEqual([]);
    // The decisive assertion: an empty inbox is NOT a read failure.
    expect(reader.readFailures()).toEqual([]);
    expect(() => enforceStrictLiveRead({
      strict: true, readExternally: true, failures: reader.readFailures(), command: 'outreach-sync-replies',
    })).not.toThrow();
  });

  it('successful read WITH a reply records no failure (exit 0)', async () => {
    const reader = new MockGmailThreadReader();
    reader.seedThread('t1', [inbound('m-1')]);
    const { svc, applied } = spyService();
    const report = await runReplySync({ reader, service: svc, threads: [thread('rec-1', 't1')], ownEmails: ['me@x.test'] });

    expect(report.repliesApplied).toHaveLength(1);
    expect(applied).toEqual(['m-1']);
    expect(reader.readFailures()).toEqual([]);
    expect(() => enforceStrictLiveRead({
      strict: true, readExternally: true, failures: reader.readFailures(), command: 'outreach-sync-replies',
    })).not.toThrow();
  });
});

describe('strict live read — a failed read is fatal', () => {
  it('ONE failing Gmail read exits non-zero in strict mode', async () => {
    const reader = new MockGmailThreadReader();
    reader.seedThreadReadFailure('t1', { reason: 'transport', detail: 'ETIMEDOUT' });
    const { svc } = spyService();
    await runReplySync({ reader, service: svc, threads: [thread('rec-1', 't1')], ownEmails: ['me@x.test'] });

    const failures = reader.readFailures();
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toBe('transport');
    expect(() => enforceStrictLiveRead({
      strict: true, readExternally: true, failures, command: 'outreach-sync-replies',
    })).toThrow(AppError);
  });

  it('MULTIPLE reads where only one fails still exits non-zero', async () => {
    const reader = new MockGmailThreadReader();
    reader.seedThread('t1', [inbound('m-1')]);   // succeeds, and finds a real reply
    reader.seedThread('t2', []);                 // succeeds, finds nothing
    reader.seedThreadReadFailure('t3', { reason: 'http_status', status: 429, detail: 'rate limited' });
    const { svc, applied } = spyService();
    await runReplySync({
      reader, service: svc,
      threads: [thread('rec-1', 't1'), thread('rec-2', 't2'), thread('rec-3', 't3')],
      ownEmails: ['me@x.test'],
    });

    // The genuine reply that WAS read stays applied — acting on it only adds suppression.
    expect(applied).toEqual(['m-1']);
    const failures = reader.readFailures();
    expect(failures).toHaveLength(1);
    expect(failures[0]?.status).toBe(429);
    expect(() => enforceStrictLiveRead({
      strict: true, readExternally: true, failures, command: 'outreach-sync-replies',
    })).toThrow(/did not complete/);
  });

  it('the SAME failure WITHOUT strict mode preserves today’s behaviour (exit 0)', async () => {
    const reader = new MockGmailThreadReader();
    reader.seedThreadReadFailure('t1');
    const { svc } = spyService();
    const report = await runReplySync({ reader, service: svc, threads: [thread('rec-1', 't1')], ownEmails: ['me@x.test'] });

    // Unchanged default: empty result, nothing inferred, no throw.
    expect(report.repliesApplied).toEqual([]);
    expect(() => enforceStrictLiveRead({
      strict: false, readExternally: true, failures: reader.readFailures(), command: 'outreach-sync-replies',
    })).not.toThrow();
  });

  it('strict mode does not fire for the offline mock reader', () => {
    // Strict governs LIVE reads; a mock cannot have an outage.
    expect(() => enforceStrictLiveRead({
      strict: true, readExternally: false,
      failures: [{ scope: 'thread', id: 't1', reason: 'transport', status: null, detail: 'x' }],
      command: 'outreach-sync-replies',
    })).not.toThrow();
  });

  it('a failed bounce search is fatal in strict mode, and a clean one is not', async () => {
    const clean = new MockGmailBounceReader();
    await clean.findDeliveryNotifications({ outbounds: [] });
    expect(clean.readFailures()).toEqual([]);
    expect(() => enforceStrictLiveRead({
      strict: true, readExternally: true, failures: clean.readFailures(), command: 'outreach-reconcile-delivery',
    })).not.toThrow();

    const broken = new MockGmailBounceReader();
    broken.seedReadFailure({ reason: 'http_status', status: 503, detail: 'backend error' });
    const out = await broken.findDeliveryNotifications({ outbounds: [] });
    expect(out).toEqual([]);                       // still nothing inferred
    expect(broken.readFailures()).toHaveLength(1); // but recorded structurally
    expect(() => enforceStrictLiveRead({
      strict: true, readExternally: true, failures: broken.readFailures(), command: 'outreach-reconcile-delivery',
    })).toThrow(AppError);
  });
});

describe('read-failure classification', () => {
  it('separates an unusable 2xx body from a non-2xx status', () => {
    expect(classifyHttpReadFailure(200, false)).toEqual({ reason: 'malformed_response', status: 200 });
    expect(classifyHttpReadFailure(401, false)).toEqual({ reason: 'http_status', status: 401 });
    expect(classifyHttpReadFailure(429, false)).toEqual({ reason: 'http_status', status: 429 });
    expect(classifyHttpReadFailure(503, false)).toEqual({ reason: 'http_status', status: 503 });
  });

  it('summarizes failures without leaking tokens or bodies', () => {
    const log = new GmailReadFailureLog();
    log.record({ scope: 'thread', id: 't1', reason: 'transport', status: null, detail: 'ECONNRESET' });
    log.record({ scope: 'search', id: null, reason: 'http_status', status: 429, detail: 'rate limited' });
    expect(log.count).toBe(2);
    const summary = summarizeGmailReadFailures(log.list());
    expect(summary).toBe('thread t1: transport; search: http_status (429)');
  });
});

describe('systemd unit uses strict mode on BOTH pre-checks', () => {
  it('both ExecStartPre lines pass --confirm-gmail-read AND --strict-live-read', () => {
    const pre = DIRECTIVES.filter((l) => l.startsWith('ExecStartPre='));
    expect(pre).toHaveLength(2);
    expect(pre[0]).toContain('outreach-sync-replies');
    expect(pre[1]).toContain('outreach-reconcile-delivery');
    for (const line of pre) {
      expect(line).toContain('--confirm-gmail-read');
      expect(line).toContain('--strict-live-read');
    }
  });

  it('still runs the follow-up runner only as ExecStart, after both guards', () => {
    const start = DIRECTIVES.filter((l) => l.startsWith('ExecStart='));
    expect(start).toHaveLength(1);
    expect(start[0]).toContain('run-followup-automation');
    expect(start[0]).not.toContain('--strict-live-read');
  });
});
