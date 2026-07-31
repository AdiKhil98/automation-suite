import { describe, expect, it } from 'vitest';
import { runDeliveryReconciliation } from '../../src/domain/outreach/delivery-reconciliation.js';
import { type RawDeliveryNotification, type TrackedOutbound } from '../../src/domain/outreach/delivery.js';
import { OutreachService } from '../../src/domain/outreach/outreach-service.js';
import { MockGmailBounceReader } from '../../src/integrations/gmail/mock-bounce-reader.js';
import { InMemoryOutreachStore } from '../support/outreach-memory.js';

const TZ = 'Europe/Berlin';
const NOW = Date.parse('2026-07-22T12:00:00Z');
const SENT_AT = Date.parse('2026-07-20T09:00:00Z');
const policy = { step1DelayDays: 3, step2DelayDays: 5, dueHourLocal: 9 };

/** Seed a sent record and return its correlation descriptor. */
async function sentOutbound(store: InMemoryOutreachStore, svc: OutreachService, over: { contact?: string; threadId?: string; gmailMsgId?: string } = {}) {
  const contact = over.contact ?? 'prospect@clinic.example';
  // Distinct lead per outbound (threadId is the unique key) so two records may share a contact.
  const leadKey = over.threadId ?? over.gmailMsgId ?? contact;
  const rec = (await svc.track({ campaignId: 'c', leadId: `l-${leadKey}`, contactEmail: contact, timezone: TZ })).record!;
  await svc.recordMessage({ outreachRecordId: rec.id, messageType: 'INITIAL', sequenceStep: 0, subject: 's', body: 'b', gmailMessageId: over.gmailMsgId ?? 'gm-out-1', gmailThreadId: over.threadId ?? 'thr-out-1', sentAt: new Date(SENT_AT) });
  await svc.transition(rec.id, 'AWAITING_APPROVAL');
  await svc.transition(rec.id, 'APPROVED_TO_SEND');
  await svc.transition(rec.id, 'INITIAL_SENT');
  await svc.scheduleFollowup(rec.id, 1, policy);
  const messageId = store.messages.find((m) => m.outreachRecordId === rec.id && m.gmailThreadId === (over.threadId ?? 'thr-out-1'))!.id;
  const outbound: TrackedOutbound = {
    outreachRecordId: rec.id,
    outreachMessageId: messageId,
    gmailMessageId: over.gmailMsgId ?? 'gm-out-1',
    gmailThreadId: over.threadId ?? 'thr-out-1',
    contactEmail: contact,
    sentAtMs: SENT_AT,
    rfcMessageId: null,
  };
  return { rec, outbound };
}

function permanentDsn(over: Partial<RawDeliveryNotification> = {}): RawDeliveryNotification {
  return {
    gmailMessageId: 'dsn-1',
    gmailThreadId: 'thr-dsn-separate',
    receivedAtMs: Date.parse('2026-07-20T09:01:00Z'),
    fromEmail: 'mailer-daemon@googlemail.com',
    subject: 'Delivery Status Notification (Failure)',
    contentType: 'multipart/report; report-type=delivery-status',
    xFailedRecipients: null,
    referencedMessageIds: [],
    deliveryStatusText: 'Action: failed\nStatus: 5.7.1\nFinal-Recipient: rfc822; prospect@clinic.example\nDiagnostic-Code: smtp; 550 5.7.1 rejected as likely unsolicited mail',
    snippet: 'Address rejected as likely unsolicited mail',
    ...over,
  };
}

describe('runDeliveryReconciliation', () => {
  it('correlates a DSN in a SEPARATE thread and applies the permanent bounce', async () => {
    const store = new InMemoryOutreachStore();
    const svc = new OutreachService(store, { now: () => NOW });
    const { rec, outbound } = await sentOutbound(store, svc);
    const reader = new MockGmailBounceReader();
    reader.seedNotification(permanentDsn()); // thread thr-dsn-separate != outbound thr-out-1

    const report = await runDeliveryReconciliation({ reader, service: svc, outbounds: [outbound], dryRun: false });
    expect(report.proposals).toHaveLength(1);
    expect(report.proposals[0]?.correlationSignal).toBe('RECIPIENT');
    expect(report.applied[0]?.outcome).toBe('BOUNCED_APPLIED');
    expect(store.records.get(rec.id)?.status).toBe('BOUNCED');
    expect(store.pendingFor(rec.id)).toHaveLength(0);
    expect(report.readExternally).toBe(false);
  });

  it('correlates by RFC Message-ID reference', async () => {
    const store = new InMemoryOutreachStore();
    const svc = new OutreachService(store, { now: () => NOW });
    const { rec, outbound } = await sentOutbound(store, svc);
    const withRfc = { ...outbound, rfcMessageId: '<out-1@mail.scaleflow>' };
    const reader = new MockGmailBounceReader();
    reader.seedNotification(permanentDsn({ deliveryStatusText: 'Action: failed\nStatus: 5.7.1\nFinal-Recipient: rfc822; nobody@else.example\nDiagnostic-Code: smtp; 550 5.7.1 rejected', referencedMessageIds: ['<out-1@mail.scaleflow>'] }));

    const report = await runDeliveryReconciliation({ reader, service: svc, outbounds: [withRfc], dryRun: false });
    expect(report.proposals[0]?.correlationSignal).toBe('RFC_MESSAGE_ID');
    expect(store.records.get(rec.id)?.status).toBe('BOUNCED');
  });

  it('DRY REPORT proposes the change but writes nothing', async () => {
    const store = new InMemoryOutreachStore();
    const svc = new OutreachService(store, { now: () => NOW });
    const { rec, outbound } = await sentOutbound(store, svc);
    const reader = new MockGmailBounceReader();
    reader.seedNotification(permanentDsn());

    const report = await runDeliveryReconciliation({ reader, service: svc, outbounds: [outbound], dryRun: true });
    expect(report.proposals).toHaveLength(1);
    expect(report.applied).toHaveLength(0);
    // No state change, no follow-up cancellation, no delivery event stored.
    expect(store.records.get(rec.id)?.status).toBe('INITIAL_SENT');
    expect(store.pendingFor(rec.id)).toHaveLength(1);
    expect(store.deliveryEvents).toHaveLength(0);
  });

  it('ignores a DSN whose failed recipient is not tracked (wrong recipient)', async () => {
    const store = new InMemoryOutreachStore();
    const svc = new OutreachService(store, { now: () => NOW });
    const { rec, outbound } = await sentOutbound(store, svc);
    const reader = new MockGmailBounceReader();
    reader.seedNotification(permanentDsn({ deliveryStatusText: 'Action: failed\nStatus: 5.7.1\nFinal-Recipient: rfc822; someone@else.example\nDiagnostic-Code: smtp; 550 5.7.1 rejected' }));

    const report = await runDeliveryReconciliation({ reader, service: svc, outbounds: [outbound], dryRun: false });
    expect(report.applied).toHaveLength(0);
    expect(report.skipped.map((s) => s.reason)).toContain('NO_CORRELATION');
    expect(store.records.get(rec.id)?.status).toBe('INITIAL_SENT');
  });

  it('ignores an unrelated, non-DSN mailbox message', async () => {
    const store = new InMemoryOutreachStore();
    const svc = new OutreachService(store, { now: () => NOW });
    const { rec, outbound } = await sentOutbound(store, svc);
    const reader = new MockGmailBounceReader();
    reader.seedNotification(permanentDsn({ fromEmail: 'dr@clinic.example', subject: 'Re: your email', contentType: 'text/plain', deliveryStatusText: null }));

    const report = await runDeliveryReconciliation({ reader, service: svc, outbounds: [outbound], dryRun: false });
    expect(report.applied).toHaveLength(0);
    expect(report.skipped.map((s) => s.reason)).toContain('NOT_A_DSN');
    expect(store.records.get(rec.id)?.status).toBe('INITIAL_SENT');
  });

  it('rejects an AMBIGUOUS correlation (two tracked outbounds share the recipient) — nothing applied', async () => {
    const store = new InMemoryOutreachStore();
    const svc = new OutreachService(store, { now: () => NOW });
    const a = await sentOutbound(store, svc, { contact: 'shared@clinic.example', threadId: 'thr-a', gmailMsgId: 'gm-a' });
    const b = await sentOutbound(store, svc, { contact: 'shared@clinic.example', threadId: 'thr-b', gmailMsgId: 'gm-b' });
    const reader = new MockGmailBounceReader();
    reader.seedNotification(permanentDsn({ gmailThreadId: 'thr-dsn-x', deliveryStatusText: 'Action: failed\nStatus: 5.7.1\nFinal-Recipient: rfc822; shared@clinic.example\nDiagnostic-Code: smtp; 550 5.7.1 rejected' }));

    const report = await runDeliveryReconciliation({ reader, service: svc, outbounds: [a.outbound, b.outbound], dryRun: false });
    expect(report.applied).toHaveLength(0);
    expect(report.skipped.map((s) => s.reason)).toContain('AMBIGUOUS_CORRELATION');
    expect(store.records.get(a.rec.id)?.status).toBe('INITIAL_SENT');
    expect(store.records.get(b.rec.id)?.status).toBe('INITIAL_SENT');
  });

  it('is idempotent across repeated runs (same DSN) and never auto-retries', async () => {
    const store = new InMemoryOutreachStore();
    const svc = new OutreachService(store, { now: () => NOW });
    const { rec, outbound } = await sentOutbound(store, svc);
    const reader = new MockGmailBounceReader();
    reader.seedNotification(permanentDsn());

    await runDeliveryReconciliation({ reader, service: svc, outbounds: [outbound], dryRun: false });
    const second = await runDeliveryReconciliation({ reader, service: svc, outbounds: [outbound], dryRun: false });
    expect(second.applied[0]?.outcome).toBe('ALREADY_RECONCILED');
    expect(store.deliveryEvents).toHaveLength(1);
    // BOUNCED and no DUE follow-up: nothing was re-armed or retried.
    expect(store.records.get(rec.id)?.status).toBe('BOUNCED');
    expect([...store.followups.values()].filter((f) => f.status === 'DUE')).toHaveLength(0);
  });

  it('records a temporary 4xx failure as DELIVERY_UNKNOWN (no state change, no retry)', async () => {
    const store = new InMemoryOutreachStore();
    const svc = new OutreachService(store, { now: () => NOW });
    const { rec, outbound } = await sentOutbound(store, svc);
    const reader = new MockGmailBounceReader();
    reader.seedNotification(permanentDsn({ deliveryStatusText: 'Action: delayed\nStatus: 4.2.2\nFinal-Recipient: rfc822; prospect@clinic.example\nDiagnostic-Code: smtp; 452 4.2.2 mailbox full' }));

    const report = await runDeliveryReconciliation({ reader, service: svc, outbounds: [outbound], dryRun: false });
    expect(report.proposals[0]?.deliveryStatus).toBe('DELIVERY_UNKNOWN');
    expect(report.applied[0]?.outcome).toBe('DELIVERY_UNKNOWN_RECORDED');
    expect(store.records.get(rec.id)?.status).toBe('INITIAL_SENT');
    expect(store.pendingFor(rec.id)).toHaveLength(1);
  });
});
