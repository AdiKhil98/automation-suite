import { describe, expect, it } from 'vitest';
import { OutreachService, type EnrollConfirmedSendInput } from '../../src/domain/outreach/outreach-service.js';
import { computeFollowupDueUtc, type SequencePolicy } from '../../src/domain/outreach/followups.js';
import { messageContentHash } from '../../src/domain/outreach/records.js';
import { InMemoryOutreachStore } from '../support/outreach-memory.js';

const TZ = 'Europe/Berlin';
const policy: SequencePolicy = { step1DelayDays: 3, step2DelayDays: 5, dueHourLocal: 9 };
const NOW = Date.parse('2026-07-20T12:00:00Z');
const SENT_AT = new Date('2026-07-20T11:59:00Z');

function build(): { store: InMemoryOutreachStore; svc: OutreachService } {
  const store = new InMemoryOutreachStore();
  const svc = new OutreachService(store, { now: () => NOW });
  return { store, svc };
}

async function trackOne(svc: OutreachService, contact = 'prospect@clinic.example') {
  const r = await svc.track({ campaignId: 'camp-1', leadId: 'lead-1', contactEmail: contact, timezone: TZ });
  return r.record!;
}

function enrollInput(recordId: string, overrides: Partial<EnrollConfirmedSendInput> = {}): EnrollConfirmedSendInput {
  return {
    outreachRecordId: recordId,
    subject: 'Something I noticed on your website',
    body: 'Your booking action is hard to find.\n\nThat adds friction before a patient books.',
    gmailMessageId: 'gmail-msg-1',
    gmailThreadId: 'gmail-thread-1',
    sentAt: SENT_AT,
    emailDraftId: 'draft-1',
    finalizedEmailId: 'final-1',
    sendAttemptId: 'attempt-1',
    policy,
    ...overrides,
  };
}

describe('OutreachService.enrollConfirmedSend', () => {
  it('enrolls a confirmed send: INITIAL step-0 message, INITIAL_SENT, follow-up 1', async () => {
    const { store, svc } = build();
    const rec = await trackOne(svc);

    const res = await svc.enrollConfirmedSend(enrollInput(rec.id));

    expect(res.outcome).toBe('ENROLLED');
    // Exact message preserved with Gmail ids + sent timestamp.
    expect(res.message?.messageType).toBe('INITIAL');
    expect(res.message?.sequenceStep).toBe(0);
    expect(res.message?.gmailMessageId).toBe('gmail-msg-1');
    expect(res.message?.gmailThreadId).toBe('gmail-thread-1');
    expect(res.message?.sentAt?.toISOString()).toBe(SENT_AT.toISOString());
    expect(res.message?.contentHash).toBe(messageContentHash(enrollInput(rec.id).subject, enrollInput(rec.id).body));
    // Record advanced to INITIAL_SENT with sent tracking.
    const stored = store.records.get(rec.id)!;
    expect(stored.status).toBe('INITIAL_SENT');
    expect(stored.lastSentAt?.toISOString()).toBe(SENT_AT.toISOString());
    expect(stored.sequenceStep).toBe(0);
    // Follow-up 1 scheduled using the sequence policy.
    const due = computeFollowupDueUtc({ previousSentAtMs: SENT_AT.getTime(), step: 1, timezone: TZ, policy });
    expect(res.followup?.step).toBe(1);
    expect(res.followup?.status).toBe('DUE');
    expect(res.followup?.dueAt.toISOString()).toBe(due.toISOString());
    expect(stored.nextFollowupAt?.toISOString()).toBe(due.toISOString());
    // Event trail.
    const types = store.eventsFor(rec.id).map((e) => e.type);
    expect(types).toEqual([
      'RECORD_CREATED', 'MESSAGE_RECORDED', 'STATE_TRANSITION', 'STATE_TRANSITION', 'STATE_TRANSITION', 'FOLLOWUP_SCHEDULED',
    ]);
  });

  it('is idempotent: a re-run returns ALREADY_ENROLLED and creates no duplicates', async () => {
    const { store, svc } = build();
    const rec = await trackOne(svc);
    await svc.enrollConfirmedSend(enrollInput(rec.id));

    const again = await svc.enrollConfirmedSend(enrollInput(rec.id));
    expect(again.outcome).toBe('ALREADY_ENROLLED');
    expect(store.messages.filter((m) => m.gmailMessageId === 'gmail-msg-1')).toHaveLength(1);
    expect(store.pendingFor(rec.id)).toHaveLength(1);
    // No extra transition/message events from the second run.
    expect(store.eventsFor(rec.id).filter((e) => e.type === 'STATE_TRANSITION')).toHaveLength(3);
  });

  it('refuses when the record cannot reach INITIAL_SENT (already sent)', async () => {
    const { store, svc } = build();
    const rec = await trackOne(svc);
    await svc.enrollConfirmedSend(enrollInput(rec.id)); // now INITIAL_SENT

    // A different confirmed send id cannot re-enroll an already-sent record.
    const res = await svc.enrollConfirmedSend(enrollInput(rec.id, { gmailMessageId: 'gmail-msg-2', gmailThreadId: 'gmail-thread-2' }));
    expect(res.outcome).toBe('RECORD_NOT_ENROLLABLE');
    expect(store.messages.filter((m) => m.gmailMessageId === 'gmail-msg-2')).toHaveLength(0);
  });

  it('refuses a bounced/terminal record without writing anything', async () => {
    const { store, svc } = build();
    const rec = await trackOne(svc);
    await svc.transition(rec.id, 'BOUNCED');

    const res = await svc.enrollConfirmedSend(enrollInput(rec.id));
    expect(res.outcome).toBe('RECORD_NOT_ENROLLABLE');
    expect(store.messages).toHaveLength(0);
    expect(store.pendingFor(rec.id)).toHaveLength(0);
  });

  it('a later reply cancels the enrolled follow-up (reply system sees the record)', async () => {
    const { store, svc } = build();
    const rec = await trackOne(svc);
    await svc.enrollConfirmedSend(enrollInput(rec.id));
    expect(store.pendingFor(rec.id)).toHaveLength(1);

    await svc.applyReply({
      outreachRecordId: rec.id,
      gmailThreadId: 'gmail-thread-1',
      gmailMessageId: 'reply-msg-1',
      fromEmail: 'prospect@clinic.example',
      receivedAtMs: NOW + 60_000,
      preview: 'Thanks, tell me more',
      classification: 'positive',
    });

    expect(store.records.get(rec.id)?.status).toBe('REPLIED_POSITIVE');
    expect(store.pendingFor(rec.id)).toHaveLength(0);
  });

  it('a permanent bounce cancels the enrolled follow-up (bounce system sees the record)', async () => {
    const { store, svc } = build();
    const rec = await trackOne(svc);
    await svc.enrollConfirmedSend(enrollInput(rec.id));

    const result = await svc.applyDeliveryFailure({
      outreachRecordId: rec.id,
      outreachMessageId: null,
      deliveryStatus: 'BOUNCED',
      permanence: 'PERMANENT',
      rejectionCode: '550 5.7.1',
      diagnosticText: 'mailbox unavailable',
      dsnStatus: '5.7.1',
      dsnAction: 'failed',
      finalRecipient: 'prospect@clinic.example',
      originalRecipient: 'prospect@clinic.example',
      bounceAtMs: NOW + 120_000,
      originalGmailMessageId: 'gmail-msg-1',
      originalGmailThreadId: 'gmail-thread-1',
      dsnGmailMessageId: 'dsn-1',
      dsnGmailThreadId: 'dsn-thread-1',
      preview: 'Delivery failed',
    });

    expect(result.outcome).toBe('BOUNCED_APPLIED');
    expect(store.records.get(rec.id)?.status).toBe('BOUNCED');
    expect(store.pendingFor(rec.id)).toHaveLength(0);
  });
});
