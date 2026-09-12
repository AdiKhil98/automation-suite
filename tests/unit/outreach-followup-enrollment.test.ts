import { describe, expect, it } from 'vitest';
import { OutreachService } from '../../src/domain/outreach/outreach-service.js';
import { type SequencePolicy } from '../../src/domain/outreach/followups.js';
import { type OutreachRecord } from '../../src/domain/outreach/records.js';
import { InMemoryOutreachStore } from '../support/outreach-memory.js';

/**
 * The confirmed-FOLLOW-UP -> outreach bridge. Every test here concerns a send that ALREADY HAPPENED
 * through the production SendService: the bridge only records it. Nothing in this file sends, and
 * the properties under test are exactly the ones that make a crash safe — idempotency, fail-closed
 * step agreement, and a sequence that stops after the final email.
 */

const TZ = 'Europe/Berlin';
const policy: SequencePolicy = { step1DelayDays: 2, step2DelayDays: 2, step3DelayDays: 3, dueHourLocal: 9 };
const NOW = Date.parse('2026-07-20T12:00:00Z');

function build(): { store: InMemoryOutreachStore; svc: OutreachService } {
  const store = new InMemoryOutreachStore();
  return { store, svc: new OutreachService(store, { now: () => NOW }) };
}

/** Track a record and enroll its confirmed INITIAL send, leaving it at FOLLOW_UP_1_DUE. */
async function initialSent(svc: OutreachService): Promise<OutreachRecord> {
  const tracked = await svc.track({ campaignId: 'camp-1', leadId: 'lead-1', contactEmail: 'prospect@clinic.example', timezone: TZ });
  const rec = tracked.record!;
  await svc.enrollConfirmedSend({
    outreachRecordId: rec.id,
    subject: 'Something I noticed on your site',
    body: 'Hello,\n\nOne observation.\n\nBest regards,',
    gmailMessageId: 'gmsg-initial',
    gmailThreadId: 'thread-1',
    sentAt: new Date(Date.parse('2026-07-20T11:00:00Z')),
    sendAttemptId: 'attempt-0',
    policy,
  });
  const after = await svc.transition(rec.id, 'FOLLOW_UP_1_DUE');
  return after;
}

/** Enroll a confirmed follow-up for `step` on a record already sitting at FOLLOW_UP_<step>_DUE. */
async function enrollFollowup(svc: OutreachService, recordId: string, step: 1 | 2 | 3, gmailMessageId: string, sentAtIso: string) {
  return svc.enrollConfirmedFollowup({
    outreachRecordId: recordId,
    expectedStep: step,
    subject: 'Re: Something I noticed on your site',
    body: `Hello,\n\nFollow-up ${String(step)} body.\n\nBest regards,`,
    gmailMessageId,
    gmailThreadId: 'thread-1',
    sentAt: new Date(Date.parse(sentAtIso)),
    emailDraftId: `draft-${String(step)}`,
    finalizedEmailId: `fin-${String(step)}`,
    sendAttemptId: `attempt-${String(step)}`,
    policy,
  });
}

describe('enrollConfirmedFollowup — recording a confirmed follow-up', () => {
  it('records the message with the right type, step, Gmail ids, and exact content', async () => {
    const { store, svc } = build();
    const rec = await initialSent(svc);
    const r = await enrollFollowup(svc, rec.id, 1, 'gmsg-f1', '2026-07-22T07:30:00Z');

    expect(r.outcome).toBe('ENROLLED');
    const msg = r.message!;
    expect(msg.messageType).toBe('FOLLOW_UP');
    expect(msg.sequenceStep).toBe(1);
    expect(msg.gmailMessageId).toBe('gmsg-f1');
    expect(msg.gmailThreadId).toBe('thread-1');
    expect(msg.finalizedEmailId).toBe('fin-1');
    expect(msg.emailDraftId).toBe('draft-1');
    expect(msg.sentAt?.toISOString()).toBe('2026-07-22T07:30:00.000Z');
    // The stored snapshot is byte-exact and hashed.
    const stored = store.messages.find((m) => m.id === msg.id)!;
    expect(stored.subject).toBe('Re: Something I noticed on your site');
    expect(stored.body).toBe('Hello,\n\nFollow-up 1 body.\n\nBest regards,');
    expect(stored.contentHash).toHaveLength(64);
  });

  it('marks the matching follow-up row SENT and advances the record', async () => {
    const { store, svc } = build();
    const rec = await initialSent(svc);
    const pendingBefore = store.pendingFor(rec.id);
    expect(pendingBefore.map((f) => f.step)).toEqual([1]);

    const r = await enrollFollowup(svc, rec.id, 1, 'gmsg-f1', '2026-07-22T07:30:00Z');

    expect(store.followups.get(pendingBefore[0]!.id)?.status).toBe('SENT');
    expect(r.sentFollowup?.id).toBe(pendingBefore[0]!.id);
    const updated = store.records.get(rec.id)!;
    expect(updated.status).toBe('FOLLOW_UP_1_SENT');
    expect(updated.sequenceStep).toBe(1);
    expect(updated.lastSentAt?.toISOString()).toBe('2026-07-22T07:30:00.000Z');
    // Timeline: message, transition, and the next schedule are all recorded.
    const types = store.eventsFor(rec.id).map((e) => e.type);
    expect(types).toContain('MESSAGE_RECORDED');
    expect(types.filter((t) => t === 'STATE_TRANSITION').length).toBeGreaterThan(0);
    expect(types).toContain('FOLLOWUP_SCHEDULED');
  });

  it('schedules the NEXT follow-up with that step’s delay', async () => {
    const { store, svc } = build();
    const rec = await initialSent(svc);
    const r = await enrollFollowup(svc, rec.id, 1, 'gmsg-f1', '2026-07-22T07:30:00Z');

    // Step 2 is +2 local days from this send, pinned to 09:00 Berlin (CEST) = 07:00 UTC.
    expect(r.nextFollowup?.step).toBe(2);
    expect(r.nextFollowup?.dueAt.toISOString()).toBe('2026-07-24T07:00:00.000Z');
    expect(store.records.get(rec.id)?.nextFollowupAt?.toISOString()).toBe('2026-07-24T07:00:00.000Z');
    expect(store.pendingFor(rec.id).map((f) => f.step)).toEqual([2]);
  });

  it('walks the whole sequence and schedules NOTHING after the final follow-up', async () => {
    const { store, svc } = build();
    const rec = await initialSent(svc);

    const r1 = await enrollFollowup(svc, rec.id, 1, 'gmsg-f1', '2026-07-22T07:30:00Z');
    expect(r1.nextFollowup?.step).toBe(2);
    await svc.transition(rec.id, 'FOLLOW_UP_2_DUE');

    const r2 = await enrollFollowup(svc, rec.id, 2, 'gmsg-f2', '2026-07-24T07:30:00Z');
    expect(r2.nextFollowup?.step).toBe(3);
    // Step 3 is +3 local days: 2026-07-27 09:00 CEST = 07:00 UTC.
    expect(r2.nextFollowup?.dueAt.toISOString()).toBe('2026-07-27T07:00:00.000Z');
    await svc.transition(rec.id, 'FOLLOW_UP_3_DUE');

    const r3 = await enrollFollowup(svc, rec.id, 3, 'gmsg-f3', '2026-07-27T07:30:00Z');
    expect(r3.outcome).toBe('ENROLLED');
    // The sequence is over: no next follow-up, no pending row, no next due instant.
    expect(r3.nextFollowup).toBeNull();
    const final = store.records.get(rec.id)!;
    expect(final.status).toBe('FOLLOW_UP_3_SENT');
    expect(final.sequenceStep).toBe(3);
    expect(final.nextFollowupAt).toBeNull();
    expect(store.pendingFor(rec.id)).toEqual([]);
    // All four sequence emails are on the record, each exactly once.
    expect(store.messages.filter((m) => m.outreachRecordId === rec.id).map((m) => m.sequenceStep).sort())
      .toEqual([0, 1, 2, 3]);
  });
});

describe('enrollConfirmedFollowup — idempotency and fail-closed behaviour', () => {
  it('is idempotent for the same Gmail message id: no duplicate state or message', async () => {
    const { store, svc } = build();
    const rec = await initialSent(svc);
    await enrollFollowup(svc, rec.id, 1, 'gmsg-f1', '2026-07-22T07:30:00Z');

    const messagesAfterFirst = store.messages.length;
    const eventsAfterFirst = store.eventsFor(rec.id).length;
    const recordAfterFirst = { ...store.records.get(rec.id)! };

    // A recovery run re-enrolls the very same confirmed send (a crash between send and tracking).
    const again = await enrollFollowup(svc, rec.id, 1, 'gmsg-f1', '2026-07-22T07:30:00Z');

    expect(again.outcome).toBe('ALREADY_ENROLLED');
    expect(store.messages).toHaveLength(messagesAfterFirst);
    expect(store.eventsFor(rec.id)).toHaveLength(eventsAfterFirst);
    expect(store.records.get(rec.id)?.status).toBe(recordAfterFirst.status);
    expect(store.records.get(rec.id)?.sequenceStep).toBe(recordAfterFirst.sequenceStep);
    expect(store.records.get(rec.id)?.nextFollowupAt?.toISOString())
      .toBe(recordAfterFirst.nextFollowupAt?.toISOString());
    // Crucially: still exactly one pending follow-up, not two.
    expect(store.pendingFor(rec.id)).toHaveLength(1);
  });

  it('heals a follow-up whose tracking crashed, without resending', async () => {
    // Recovery scenario: Gmail confirmed the send, but the process died before enrollment. The
    // record is still FOLLOW_UP_1_DUE and the message is absent, so the next run simply records it.
    const { store, svc } = build();
    const rec = await initialSent(svc);
    expect(store.messages.some((m) => m.gmailMessageId === 'gmsg-f1')).toBe(false);
    expect(store.records.get(rec.id)?.status).toBe('FOLLOW_UP_1_DUE');

    const healed = await enrollFollowup(svc, rec.id, 1, 'gmsg-f1', '2026-07-22T07:30:00Z');

    expect(healed.outcome).toBe('ENROLLED');
    expect(store.records.get(rec.id)?.status).toBe('FOLLOW_UP_1_SENT');
    // The healed message is the one Gmail already delivered — enrollment never produces a send.
    expect(store.messages.filter((m) => m.gmailMessageId === 'gmsg-f1')).toHaveLength(1);
  });

  it('fails closed when provenance and record state disagree about the step', async () => {
    const { store, svc } = build();
    const rec = await initialSent(svc); // awaiting step 1
    const before = { messages: store.messages.length, events: store.eventsFor(rec.id).length };

    const r = await enrollFollowup(svc, rec.id, 3, 'gmsg-wrong', '2026-07-22T07:30:00Z');

    expect(r.outcome).toBe('STEP_MISMATCH');
    expect(r.message).toBeNull();
    expect(store.messages).toHaveLength(before.messages);
    expect(store.eventsFor(rec.id)).toHaveLength(before.events);
    expect(store.records.get(rec.id)?.status).toBe('FOLLOW_UP_1_DUE');
  });

  it('refuses a record that is not awaiting any follow-up', async () => {
    const { store, svc } = build();
    const tracked = await svc.track({ campaignId: 'camp-1', leadId: 'lead-1', contactEmail: 'p@clinic.example', timezone: TZ });
    const rec = tracked.record!;
    await svc.enrollConfirmedSend({
      outreachRecordId: rec.id, subject: 's', body: 'b', gmailMessageId: 'gmsg-initial',
      gmailThreadId: 'thread-1', sentAt: new Date(NOW), sendAttemptId: 'a0', policy,
    });
    // Still INITIAL_SENT — no follow-up has been marked due yet.
    const r = await enrollFollowup(svc, rec.id, 1, 'gmsg-f1', '2026-07-22T07:30:00Z');
    expect(r.outcome).toBe('RECORD_NOT_ENROLLABLE');
    expect(store.messages.some((m) => m.gmailMessageId === 'gmsg-f1')).toBe(false);
  });

  it('refuses after the sequence has finished', async () => {
    const { svc } = build();
    const rec = await initialSent(svc);
    await enrollFollowup(svc, rec.id, 1, 'gmsg-f1', '2026-07-22T07:30:00Z');
    await svc.transition(rec.id, 'FOLLOW_UP_2_DUE');
    await enrollFollowup(svc, rec.id, 2, 'gmsg-f2', '2026-07-24T07:30:00Z');
    await svc.transition(rec.id, 'FOLLOW_UP_3_DUE');
    await enrollFollowup(svc, rec.id, 3, 'gmsg-f3', '2026-07-27T07:30:00Z');

    // A hypothetical fifth email can never be recorded: FOLLOW_UP_3_SENT awaits nothing.
    const extra = await enrollFollowup(svc, rec.id, 3, 'gmsg-f4', '2026-07-30T07:30:00Z');
    expect(extra.outcome).toBe('RECORD_NOT_ENROLLABLE');
  });

  it('refuses once the prospect has replied, even though the record has a due follow-up', async () => {
    const { store, svc } = build();
    const rec = await initialSent(svc);
    await svc.transition(rec.id, 'REPLIED_POSITIVE');

    const r = await enrollFollowup(svc, rec.id, 1, 'gmsg-f1', '2026-07-22T07:30:00Z');
    expect(r.outcome).toBe('RECORD_NOT_ENROLLABLE');
    expect(store.messages.some((m) => m.gmailMessageId === 'gmsg-f1')).toBe(false);
  });
});
