import { describe, expect, it } from 'vitest';
import { OutreachService } from '../../src/domain/outreach/outreach-service.js';
import { runReplySync, type TrackedThread } from '../../src/domain/outreach/reply-sync.js';
import { type InboundMessage } from '../../src/domain/outreach/reply-classification.js';
import { MockGmailThreadReader } from '../../src/integrations/gmail/mock-reply-provider.js';
import { InMemoryOutreachStore } from '../support/outreach-memory.js';

const TZ = 'Europe/Berlin';
const NOW = Date.parse('2026-07-22T12:00:00Z');
const OWN = ['outreach@agency.example'];

function inbound(over: Partial<InboundMessage>): InboundMessage {
  return {
    messageId: 'in-1', threadId: 'thr-1', fromEmail: 'prospect@clinic.example',
    receivedAtMs: Date.parse('2026-07-21T10:00:00Z'), preview: '',
    headers: { fromEmail: 'prospect@clinic.example' }, ...over,
  };
}

async function seededRecord() {
  const store = new InMemoryOutreachStore();
  const svc = new OutreachService(store, { now: () => NOW });
  const rec = (await svc.track({ campaignId: 'c', leadId: 'l', contactEmail: 'prospect@clinic.example', timezone: TZ })).record!;
  await svc.recordMessage({ outreachRecordId: rec.id, messageType: 'INITIAL', sequenceStep: 0, subject: 's', body: 'b', gmailThreadId: 'thr-1', sentAt: new Date(Date.parse('2026-07-20T09:00:00Z')) });
  return { store, svc, rec };
}

describe('runReplySync', () => {
  it('detects and applies a genuine inbound reply, excluding self-messages', async () => {
    const { store, svc, rec } = await seededRecord();
    const reader = new MockGmailThreadReader();
    reader.seedThread('thr-1', [
      inbound({ messageId: 'self', fromEmail: 'outreach@agency.example', receivedAtMs: Date.parse('2026-07-20T09:00:00Z') }),
      inbound({ messageId: 'reply-1', preview: 'Interested — please book a call', receivedAtMs: Date.parse('2026-07-21T10:00:00Z') }),
    ]);
    const threads: TrackedThread[] = [
      { outreachRecordId: rec.id, threadId: 'thr-1', lastOutboundAtMs: Date.parse('2026-07-20T09:00:00Z'), handledMessageIds: [] },
    ];
    const report = await runReplySync({ reader, service: svc, threads, ownEmails: OWN });
    expect(report.repliesApplied).toHaveLength(1);
    expect(report.repliesApplied[0]?.classification).toBe('positive');
    expect(store.records.get(rec.id)?.status).toBe('REPLIED_POSITIVE');
    expect(report.readExternally).toBe(false);
  });

  it('is idempotent: an already-handled message is not re-applied', async () => {
    const { svc, rec } = await seededRecord();
    const reader = new MockGmailThreadReader();
    reader.seedThread('thr-1', [inbound({ messageId: 'reply-1', preview: 'ok', receivedAtMs: Date.parse('2026-07-21T10:00:00Z') })]);
    const threads: TrackedThread[] = [
      { outreachRecordId: rec.id, threadId: 'thr-1', lastOutboundAtMs: Date.parse('2026-07-20T09:00:00Z'), handledMessageIds: ['reply-1'] },
    ];
    const report = await runReplySync({ reader, service: svc, threads, ownEmails: OWN });
    expect(report.repliesApplied).toHaveLength(0);
  });
});
