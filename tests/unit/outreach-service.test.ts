import { describe, expect, it } from 'vitest';
import { OutreachService } from '../../src/domain/outreach/outreach-service.js';
import { type SequencePolicy } from '../../src/domain/outreach/followups.js';
import { InvalidOutreachTransitionError } from '../../src/utils/errors.js';
import { InMemoryOutreachStore } from '../support/outreach-memory.js';

const TZ = 'Europe/Berlin';
const policy: SequencePolicy = { step1DelayDays: 3, step2DelayDays: 5, dueHourLocal: 9 };
const NOW = Date.parse('2026-07-20T12:00:00Z');

function build(): { store: InMemoryOutreachStore; svc: OutreachService } {
  const store = new InMemoryOutreachStore();
  const svc = new OutreachService(store, { now: () => NOW });
  return { store, svc };
}

async function trackOne(svc: OutreachService, contact = 'prospect@clinic.example') {
  const r = await svc.track({ campaignId: 'camp-1', leadId: 'lead-1', contactEmail: contact, timezone: TZ });
  return r.record!;
}

describe('OutreachService.track', () => {
  it('creates a record and a RECORD_CREATED event', async () => {
    const { store, svc } = build();
    const result = await svc.track({ campaignId: 'camp-1', leadId: 'lead-1', contactEmail: 'A@Clinic.Example', timezone: TZ });
    expect(result.outcome).toBe('CREATED');
    expect(result.record?.contactEmail).toBe('a@clinic.example'); // normalized
    expect(store.eventsFor(result.record!.id)[0]?.type).toBe('RECORD_CREATED');
  });

  it('prevents a duplicate ACTIVE record for the same (campaign, lead, contact)', async () => {
    const { svc } = build();
    await trackOne(svc);
    const dup = await svc.track({ campaignId: 'camp-1', leadId: 'lead-1', contactEmail: 'prospect@clinic.example', timezone: TZ });
    expect(dup.outcome).toBe('DUPLICATE_ACTIVE');
  });

  it('blocks tracking a do-not-contact contact', async () => {
    const { svc } = build();
    const rec = await trackOne(svc);
    await svc.transition(rec.id, 'UNSUBSCRIBED'); // sets doNotContact
    const blocked = await svc.track({ campaignId: 'camp-2', leadId: 'lead-9', contactEmail: 'prospect@clinic.example', timezone: TZ });
    expect(blocked.outcome).toBe('BLOCKED_DO_NOT_CONTACT');
    expect(blocked.record).toBeNull();
  });
});

describe('OutreachService.transition', () => {
  it('applies a valid transition and records the event', async () => {
    const { store, svc } = build();
    const rec = await trackOne(svc);
    const updated = await svc.transition(rec.id, 'AWAITING_APPROVAL');
    expect(updated.status).toBe('AWAITING_APPROVAL');
    const types = store.eventsFor(rec.id).map((e) => e.type);
    expect(types).toContain('STATE_TRANSITION');
  });

  it('rejects an invalid transition and leaves the record unchanged', async () => {
    const { store, svc } = build();
    const rec = await trackOne(svc);
    await expect(svc.transition(rec.id, 'CLOSED_WON')).rejects.toBeInstanceOf(InvalidOutreachTransitionError);
    expect(store.records.get(rec.id)?.status).toBe('DRAFT_READY');
    // Nothing was appended for the rejected attempt (whole tx rolled back).
    expect(store.eventsFor(rec.id).map((e) => e.type)).toEqual(['RECORD_CREATED']);
  });
});

describe('OutreachService.recordMessage', () => {
  it('preserves the exact subject and body and advances a sent record', async () => {
    const { store, svc } = build();
    const rec = await trackOne(svc);
    const subject = 'Ihre Website — ein konkreter Vorschlag';
    const body = 'Hallo,\n\nmir ist Folgendes aufgefallen …\n\nBeste Grüße';
    const msg = await svc.recordMessage({
      outreachRecordId: rec.id, messageType: 'INITIAL', sequenceStep: 0, subject, body,
      gmailMessageId: 'gmsg-1', gmailThreadId: 'thr-1', sentAt: new Date(NOW),
    });
    const stored = store.messages.find((m) => m.id === msg.id)!;
    expect(stored.subject).toBe(subject);
    expect(stored.body).toBe(body);
    expect(store.records.get(rec.id)?.lastSentAt?.getTime()).toBe(NOW);
    // Recording a second message never overwrites the first.
    await svc.recordMessage({ outreachRecordId: rec.id, messageType: 'FOLLOW_UP', sequenceStep: 1, subject: 'Kurze Nachfrage', body: 'Nur eine kurze Erinnerung.' });
    expect(store.messages.filter((m) => m.outreachRecordId === rec.id)).toHaveLength(2);
    expect(store.messages[0]?.subject).toBe(subject); // unchanged
  });
});

describe('OutreachService follow-ups and replies', () => {
  it('schedules a follow-up only after a send', async () => {
    const { svc } = build();
    const rec = await trackOne(svc);
    const blocked = await svc.scheduleFollowup(rec.id, 1, policy);
    expect(blocked.outcome).toBe('BLOCKED');
    expect(blocked.reason).toBe('NO_PRIOR_SEND');

    await svc.recordMessage({ outreachRecordId: rec.id, messageType: 'INITIAL', sequenceStep: 0, subject: 's', body: 'b', sentAt: new Date(NOW) });
    const ok = await svc.scheduleFollowup(rec.id, 1, policy);
    expect(ok.outcome).toBe('SCHEDULED');
    expect(ok.followup?.dueAt.toISOString()).toBe('2026-07-23T07:00:00.000Z');
  });

  it('a reply cancels all pending follow-ups and sets reply metadata', async () => {
    const { store, svc } = build();
    const rec = await trackOne(svc);
    await svc.recordMessage({ outreachRecordId: rec.id, messageType: 'INITIAL', sequenceStep: 0, subject: 's', body: 'b', gmailThreadId: 'thr-1', sentAt: new Date(NOW) });
    await svc.scheduleFollowup(rec.id, 1, policy);
    expect(store.pendingFor(rec.id)).toHaveLength(1);

    await svc.applyReply({
      outreachRecordId: rec.id, gmailThreadId: 'thr-1', gmailMessageId: 'in-1',
      fromEmail: 'prospect@clinic.example', receivedAtMs: Date.parse('2026-07-21T09:00:00Z'),
      preview: 'This sounds good, can we book a call?', classification: 'positive',
    });
    const updated = store.records.get(rec.id)!;
    expect(updated.status).toBe('REPLIED_POSITIVE');
    expect(updated.replyCategory).toBe('positive');
    expect(updated.nextFollowupAt).toBeNull();
    expect(store.pendingFor(rec.id)).toHaveLength(0);
    expect(store.replies).toHaveLength(1);
  });

  it('a bounce cancels pending follow-ups', async () => {
    const { store, svc } = build();
    const rec = await trackOne(svc);
    await svc.recordMessage({ outreachRecordId: rec.id, messageType: 'INITIAL', sequenceStep: 0, subject: 's', body: 'b', gmailThreadId: 'thr-1', sentAt: new Date(NOW) });
    await svc.scheduleFollowup(rec.id, 1, policy);
    await svc.applyReply({
      outreachRecordId: rec.id, gmailThreadId: 'thr-1', gmailMessageId: 'in-2',
      fromEmail: 'mailer-daemon@googlemail.com', receivedAtMs: Date.parse('2026-07-21T09:00:00Z'),
      preview: 'Address not found', classification: 'bounce',
    });
    expect(store.records.get(rec.id)?.status).toBe('BOUNCED');
    expect(store.pendingFor(rec.id)).toHaveLength(0);
  });

  it('an unsubscribe reply creates do-not-contact', async () => {
    const { store, svc } = build();
    const rec = await trackOne(svc);
    await svc.recordMessage({ outreachRecordId: rec.id, messageType: 'INITIAL', sequenceStep: 0, subject: 's', body: 'b', gmailThreadId: 'thr-1', sentAt: new Date(NOW) });
    await svc.applyReply({
      outreachRecordId: rec.id, gmailThreadId: 'thr-1', gmailMessageId: 'in-3',
      fromEmail: 'prospect@clinic.example', receivedAtMs: Date.parse('2026-07-21T09:00:00Z'),
      preview: 'unsubscribe please', classification: 'unsubscribe',
    });
    const r = store.records.get(rec.id)!;
    expect(r.status).toBe('UNSUBSCRIBED');
    expect(r.doNotContact).toBe(true);
  });

  it('blocks scheduling a follow-up after a reply', async () => {
    const { svc } = build();
    const rec = await trackOne(svc);
    await svc.recordMessage({ outreachRecordId: rec.id, messageType: 'INITIAL', sequenceStep: 0, subject: 's', body: 'b', sentAt: new Date(NOW) });
    await svc.applyReply({
      outreachRecordId: rec.id, gmailThreadId: 'thr-1', gmailMessageId: 'in-4',
      fromEmail: 'prospect@clinic.example', receivedAtMs: NOW, preview: 'ok', classification: 'neutral',
    });
    const res = await svc.scheduleFollowup(rec.id, 1, policy);
    expect(res.outcome).toBe('BLOCKED');
    expect(res.reason).toBe('REPLY_DETECTED');
  });
});

describe('OutreachService event timeline', () => {
  it('assigns strictly increasing per-record seq in order', async () => {
    const { store, svc } = build();
    const rec = await trackOne(svc);
    await svc.transition(rec.id, 'AWAITING_APPROVAL');
    await svc.transition(rec.id, 'APPROVED_TO_SEND');
    await svc.recordMessage({ outreachRecordId: rec.id, messageType: 'INITIAL', sequenceStep: 0, subject: 's', body: 'b', sentAt: new Date(NOW) });
    const seqs = store.eventsFor(rec.id).map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length); // unique
    expect(seqs[0]).toBe(1);
  });
});
