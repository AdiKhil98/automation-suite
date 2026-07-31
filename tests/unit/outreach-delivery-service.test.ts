import { describe, expect, it } from 'vitest';
import {
  OutreachService,
  type ApplyDeliveryFailureInput,
} from '../../src/domain/outreach/outreach-service.js';
import { InMemoryOutreachStore } from '../support/outreach-memory.js';

const TZ = 'Europe/Berlin';
const NOW = Date.parse('2026-07-22T12:00:00Z');
const SENT_AT = Date.parse('2026-07-20T09:00:00Z');
const BOUNCE_AT = Date.parse('2026-07-20T09:01:00Z');
const policy = { step1DelayDays: 3, step2DelayDays: 5, dueHourLocal: 9 };

/** Seed a record that has been sent (INITIAL_SENT) with one pending follow-up. */
async function sentRecord(store: InMemoryOutreachStore, svc: OutreachService) {
  const rec = (await svc.track({ campaignId: 'c', leadId: 'l', contactEmail: 'prospect@clinic.example', timezone: TZ })).record!;
  await svc.recordMessage({ outreachRecordId: rec.id, messageType: 'INITIAL', sequenceStep: 0, subject: 's', body: 'b', gmailMessageId: 'gm-out-1', gmailThreadId: 'thr-out-1', sentAt: new Date(SENT_AT) });
  await svc.transition(rec.id, 'AWAITING_APPROVAL');
  await svc.transition(rec.id, 'APPROVED_TO_SEND');
  await svc.transition(rec.id, 'INITIAL_SENT');
  await svc.scheduleFollowup(rec.id, 1, policy);
  const messageId = store.messages.find((m) => m.outreachRecordId === rec.id)!.id;
  return { rec, messageId };
}

function bounceInput(recordId: string, messageId: string, over: Partial<ApplyDeliveryFailureInput> = {}): ApplyDeliveryFailureInput {
  return {
    outreachRecordId: recordId,
    outreachMessageId: messageId,
    deliveryStatus: 'BOUNCED',
    permanence: 'PERMANENT',
    rejectionCode: '550 5.7.1',
    diagnosticText: 'smtp; 550 5.7.1 The message was rejected as likely unsolicited mail',
    dsnStatus: '5.7.1',
    dsnAction: 'failed',
    finalRecipient: 'prospect@clinic.example',
    originalRecipient: null,
    bounceAtMs: BOUNCE_AT,
    originalGmailMessageId: 'gm-out-1',
    originalGmailThreadId: 'thr-out-1',
    dsnGmailMessageId: 'dsn-1',
    dsnGmailThreadId: 'thr-dsn-sep',
    preview: 'Address rejected',
    ...over,
  };
}

describe('OutreachService.applyDeliveryFailure — permanent bounce', () => {
  it('transitions the record to BOUNCED and records a delivery event', async () => {
    const store = new InMemoryOutreachStore();
    const svc = new OutreachService(store, { now: () => NOW });
    const { rec, messageId } = await sentRecord(store, svc);

    const result = await svc.applyDeliveryFailure(bounceInput(rec.id, messageId));
    expect(result.outcome).toBe('BOUNCED_APPLIED');
    expect(store.records.get(rec.id)?.status).toBe('BOUNCED');
    expect(store.deliveryEvents).toHaveLength(1);
    expect(store.deliveryEvents[0]?.rejectionCode).toBe('550 5.7.1');
    expect(store.deliveryEvents[0]?.deliveryStatus).toBe('BOUNCED');
  });

  it('cancels every pending follow-up', async () => {
    const store = new InMemoryOutreachStore();
    const svc = new OutreachService(store, { now: () => NOW });
    const { rec, messageId } = await sentRecord(store, svc);
    expect(store.pendingFor(rec.id)).toHaveLength(1);
    await svc.applyDeliveryFailure(bounceInput(rec.id, messageId));
    expect(store.pendingFor(rec.id)).toHaveLength(0);
  });

  it('appends BOUNCE_DETECTED and FOLLOWUPS_CANCELLED events', async () => {
    const store = new InMemoryOutreachStore();
    const svc = new OutreachService(store, { now: () => NOW });
    const { rec, messageId } = await sentRecord(store, svc);
    await svc.applyDeliveryFailure(bounceInput(rec.id, messageId));
    const types = store.eventsFor(rec.id).map((e) => e.type);
    expect(types).toContain('BOUNCE_DETECTED');
    expect(types).toContain('FOLLOWUPS_CANCELLED');
  });

  it('preserves the original INITIAL_SENT event and the sent timestamp (never mutates history)', async () => {
    const store = new InMemoryOutreachStore();
    const svc = new OutreachService(store, { now: () => NOW });
    const { rec, messageId } = await sentRecord(store, svc);
    await svc.applyDeliveryFailure(bounceInput(rec.id, messageId));
    // The INITIAL_SENT transition event still exists.
    const initialSent = store.eventsFor(rec.id).find((e) => e.type === 'STATE_TRANSITION' && e.toStatus === 'INITIAL_SENT');
    expect(initialSent).toBeDefined();
    // The immutable message row keeps its sent timestamp and gmail id.
    const msg = store.messages.find((m) => m.id === messageId)!;
    expect(msg.sentAt?.getTime()).toBe(SENT_AT);
    expect(msg.gmailMessageId).toBe('gm-out-1');
  });

  it('does NOT set do-not-contact and does not create any retry follow-up', async () => {
    const store = new InMemoryOutreachStore();
    const svc = new OutreachService(store, { now: () => NOW });
    const { rec, messageId } = await sentRecord(store, svc);
    await svc.applyDeliveryFailure(bounceInput(rec.id, messageId));
    expect(store.records.get(rec.id)?.doNotContact).toBe(false);
    // No DUE follow-up remains and none was re-armed — nothing is auto-retried.
    expect([...store.followups.values()].filter((f) => f.status === 'DUE')).toHaveLength(0);
  });

  it('is idempotent for a repeated DSN (same dsn message id) — no double apply', async () => {
    const store = new InMemoryOutreachStore();
    const svc = new OutreachService(store, { now: () => NOW });
    const { rec, messageId } = await sentRecord(store, svc);
    await svc.applyDeliveryFailure(bounceInput(rec.id, messageId));
    const eventsAfterFirst = store.eventsFor(rec.id).length;

    const second = await svc.applyDeliveryFailure(bounceInput(rec.id, messageId));
    expect(second.outcome).toBe('ALREADY_RECONCILED');
    expect(store.deliveryEvents).toHaveLength(1); // not duplicated
    expect(store.eventsFor(rec.id).length).toBe(eventsAfterFirst); // no new events
  });
});

describe('OutreachService.applyDeliveryFailure — temporary failure', () => {
  it('records DELIVERY_UNKNOWN without changing state, cancelling follow-ups, or retrying', async () => {
    const store = new InMemoryOutreachStore();
    const svc = new OutreachService(store, { now: () => NOW });
    const { rec, messageId } = await sentRecord(store, svc);

    const result = await svc.applyDeliveryFailure(
      bounceInput(rec.id, messageId, { deliveryStatus: 'DELIVERY_UNKNOWN', permanence: 'TEMPORARY', dsnStatus: '4.2.2', rejectionCode: '452 4.2.2', dsnGmailMessageId: 'dsn-temp-1' }),
    );
    expect(result.outcome).toBe('DELIVERY_UNKNOWN_RECORDED');
    // State is unchanged (still a sent, non-terminal record) and the follow-up remains.
    expect(store.records.get(rec.id)?.status).toBe('INITIAL_SENT');
    expect(store.pendingFor(rec.id)).toHaveLength(1);
    // Recorded for operator review; never transitions to BOUNCED and never retries.
    expect(store.deliveryEvents[0]?.deliveryStatus).toBe('DELIVERY_UNKNOWN');
    expect(store.eventsFor(rec.id).map((e) => e.type)).toContain('DELIVERY_UNKNOWN');
    expect(store.eventsFor(rec.id).map((e) => e.type)).not.toContain('BOUNCE_DETECTED');
  });
});

describe('OutreachService.applyDeliveryFailure — already terminal', () => {
  it('SKIPS a terminal (already BOUNCED) record and writes NO new delivery event', async () => {
    const store = new InMemoryOutreachStore();
    const svc = new OutreachService(store, { now: () => NOW });
    const { rec, messageId } = await sentRecord(store, svc);
    await svc.applyDeliveryFailure(bounceInput(rec.id, messageId));
    expect(store.records.get(rec.id)?.status).toBe('BOUNCED');
    const eventsAfterFirst = store.eventsFor(rec.id).length;

    // A second, different DSN for the now-terminal record must not accrue a late event.
    const second = await svc.applyDeliveryFailure(bounceInput(rec.id, messageId, { dsnGmailMessageId: 'dsn-2' }));
    expect(second.outcome).toBe('SKIPPED_TERMINAL');
    expect(store.records.get(rec.id)?.status).toBe('BOUNCED');
    expect(store.deliveryEvents).toHaveLength(1); // no new delivery event written
    expect(store.eventsFor(rec.id).length).toBe(eventsAfterFirst); // no new timeline event
  });

  it('SKIPS a record that was already resolved by another path (BOUNCED via reply-sync)', async () => {
    const store = new InMemoryOutreachStore();
    const svc = new OutreachService(store, { now: () => NOW });
    const { rec, messageId } = await sentRecord(store, svc);
    // Resolve it terminally by a different path first (a genuine bounce reply).
    await svc.applyReply({ outreachRecordId: rec.id, gmailThreadId: 'thr-out-1', gmailMessageId: 'reply-b', fromEmail: 'mailer-daemon@googlemail.com', receivedAtMs: NOW, preview: 'Address not found', classification: 'bounce' });
    expect(store.records.get(rec.id)?.status).toBe('BOUNCED');

    const res = await svc.applyDeliveryFailure(bounceInput(rec.id, messageId, { dsnGmailMessageId: 'dsn-late' }));
    expect(res.outcome).toBe('SKIPPED_TERMINAL');
    expect(store.deliveryEvents).toHaveLength(0); // reconciliation added nothing
  });
});
