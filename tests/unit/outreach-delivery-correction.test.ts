import { describe, expect, it } from 'vitest';
import { OutreachService } from '../../src/domain/outreach/outreach-service.js';
import { type OutreachDeliveryEvent } from '../../src/domain/outreach/records.js';
import { InMemoryOutreachStore } from '../support/outreach-memory.js';

const NOW = Date.parse('2026-07-31T12:00:00Z');

/** Seed a record that is BOUNCED (resolved by another path) with N attached delivery events. */
async function seedBounced(store: InMemoryOutreachStore, svc: OutreachService, dsnIds: string[]) {
  const rec = (await svc.track({ campaignId: 'c', leadId: 'l', contactEmail: 'p@clinic.example', timezone: 'UTC' })).record!;
  // Resolve terminally via a genuine bounce reply (mirrors the incident: reply-sync BOUNCED it).
  await svc.applyReply({ outreachRecordId: rec.id, gmailThreadId: 't', gmailMessageId: 'r1', fromEmail: 'mailer-daemon@googlemail.com', receivedAtMs: NOW, preview: 'Address not found', classification: 'bounce' });
  // Directly attach the (incorrect) delivery events, as the buggy reconciliation had done.
  for (const dsn of dsnIds) {
    const evt: OutreachDeliveryEvent = {
      id: `de-${dsn}`, outreachRecordId: rec.id, outreachMessageId: null,
      deliveryStatus: 'DELIVERY_UNKNOWN', permanence: 'UNKNOWN', rejectionCode: null, diagnosticText: null,
      dsnStatus: null, dsnAction: null, finalRecipient: null, originalRecipient: null, bounceAt: null,
      originalGmailMessageId: null, originalGmailThreadId: null, dsnGmailMessageId: dsn, dsnGmailThreadId: null,
      preview: 'x', supersededAt: null, supersededReason: null, supersededBy: null, createdAt: new Date(NOW),
    };
    store.deliveryEvents.push(evt);
  }
  return rec;
}

const FIVE = ['19fb2ad74dcbc858', '19fb283aaf8d1bb4', '19e377fe744e940f', '19e377e7d1ef4eab', '19e262197cc7fd35'];

describe('OutreachService.correctDeliveryEvents (Phase 17C1)', () => {
  it('DRY RUN reports the plan and writes nothing', async () => {
    const store = new InMemoryOutreachStore();
    const svc = new OutreachService(store, { now: () => NOW });
    await seedBounced(store, svc, FIVE);

    const res = await svc.correctDeliveryEvents({ dsnGmailMessageIds: FIVE, reason: 'mis-correlated', by: 'adi', dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.applied).toBe(false);
    expect(res.toSupersedeCount).toBe(5);
    // Nothing written: no event is superseded, no correction event appended.
    expect(store.deliveryEvents.every((e) => e.supersededAt === null)).toBe(true);
  });

  it('APPLY invalidates (supersedes) the events without deleting them and keeps the record BOUNCED', async () => {
    const store = new InMemoryOutreachStore();
    const svc = new OutreachService(store, { now: () => NOW });
    const rec = await seedBounced(store, svc, FIVE);

    const res = await svc.correctDeliveryEvents({ dsnGmailMessageIds: FIVE, reason: 'DSN predates outbound / already BOUNCED', by: 'adi', dryRun: false });
    expect(res.applied).toBe(true);
    expect(res.toSupersedeCount).toBe(5);
    // History preserved: the 5 rows still exist, now marked superseded with reason + operator.
    expect(store.deliveryEvents).toHaveLength(5);
    for (const e of store.deliveryEvents) {
      expect(e.supersededAt).not.toBeNull();
      expect(e.supersededReason).toContain('predates');
      expect(e.supersededBy).toBe('adi');
    }
    // The record remains BOUNCED and its (already cancelled) follow-up is untouched.
    expect(store.records.get(rec.id)?.status).toBe('BOUNCED');
    // One immutable correction event is appended to the record's timeline.
    const corrected = store.eventsFor(rec.id).filter((e) => e.type === 'DELIVERY_RECONCILIATION_CORRECTED');
    expect(corrected).toHaveLength(1);
    expect(res.recordsAnnotated).toEqual([rec.id]);
  });

  it('is idempotent: a repeated correction supersedes nothing more and appends no new event', async () => {
    const store = new InMemoryOutreachStore();
    const svc = new OutreachService(store, { now: () => NOW });
    const rec = await seedBounced(store, svc, FIVE);
    await svc.correctDeliveryEvents({ dsnGmailMessageIds: FIVE, reason: 'r', by: 'adi', dryRun: false });
    const eventsAfterFirst = store.eventsFor(rec.id).length;

    const second = await svc.correctDeliveryEvents({ dsnGmailMessageIds: FIVE, reason: 'r', by: 'adi', dryRun: false });
    expect(second.applied).toBe(false);
    expect(second.toSupersedeCount).toBe(0);
    expect(second.alreadySupersededCount).toBe(5);
    expect(store.eventsFor(rec.id).length).toBe(eventsAfterFirst); // no new correction event
  });

  it('reports ids that are not found and never fabricates a correction', async () => {
    const store = new InMemoryOutreachStore();
    const svc = new OutreachService(store, { now: () => NOW });
    await seedBounced(store, svc, ['known-1']);
    const res = await svc.correctDeliveryEvents({ dsnGmailMessageIds: ['known-1', 'missing-1'], reason: 'r', by: 'adi', dryRun: false });
    expect(res.toSupersedeCount).toBe(1);
    expect(res.notFound).toEqual(['missing-1']);
  });
});
