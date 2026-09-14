import { describe, expect, it } from 'vitest';
import { OutreachService } from '../../src/domain/outreach/outreach-service.js';
import { type OutreachFollowup, type OutreachRecord } from '../../src/domain/outreach/records.js';
import { type OutreachStatus } from '../../src/domain/outreach/status.js';
import { InMemoryOutreachStore } from '../support/outreach-memory.js';

/**
 * `OutreachService.promoteFollowupDue` — the ONLY automated writer of a `FOLLOW_UP_N_DUE` status.
 *
 * The properties pinned here are the durable ones: the caller's worklist snapshot is never trusted
 * (state is re-read and re-decided inside the transaction), the write is a compare-and-set so a
 * concurrent writer cannot be clobbered, the immutable timeline gains exactly one event when — and
 * only when — the status actually changed, and the follow-up row itself is never touched.
 */

const NOW = Date.parse('2026-09-14T10:00:00Z');
const DUE = Date.parse('2026-09-14T09:00:00Z');
const REC = 'rec-1';
const FOLLOWUP = 'f1';

function seed(over: { record?: Partial<OutreachRecord>; followup?: Partial<OutreachFollowup> } = {}) {
  const store = new InMemoryOutreachStore();
  const record: OutreachRecord = {
    id: REC,
    campaignId: 'camp-1',
    leadId: 'lead-1',
    contactEmail: 'reception@clinic.example',
    status: 'INITIAL_SENT',
    sequenceStep: 0,
    owner: null,
    timezone: 'Europe/London',
    lastSentAt: new Date(DUE - 2 * 86_400_000),
    nextFollowupAt: new Date(DUE),
    lastReplyAt: null,
    replyCategory: null,
    doNotContact: false,
    outcome: null,
    notes: null,
    createdAt: new Date(DUE - 2 * 86_400_000),
    updatedAt: new Date(DUE - 2 * 86_400_000),
    ...over.record,
  };
  const followup: OutreachFollowup = {
    id: FOLLOWUP,
    outreachRecordId: REC,
    step: 1,
    dueAt: new Date(DUE),
    timezone: 'Europe/London',
    status: 'DUE',
    blockedReason: null,
    cancelledReason: null,
    createdAt: new Date(DUE - 2 * 86_400_000),
    updatedAt: new Date(DUE - 2 * 86_400_000),
    ...over.followup,
  };
  store.records.set(record.id, record);
  store.followups.set(followup.id, followup);
  const service = new OutreachService(store, { now: () => NOW });
  return { store, service, record, followup };
}

const promote = (service: OutreachService) =>
  service.promoteFollowupDue({ followupId: FOLLOWUP, outreachRecordId: REC, actor: 'followup-automation' });

describe('promoteFollowupDue — the durable write', () => {
  it('promotes INITIAL_SENT to FOLLOW_UP_1_DUE and appends exactly one event', async () => {
    const { store, service } = seed();
    const r = await promote(service);

    expect(r.outcome).toBe('PROMOTED');
    expect(store.records.get(REC)?.status).toBe('FOLLOW_UP_1_DUE');
    const events = store.eventsFor(REC);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('STATE_TRANSITION');
    expect(events[0]?.fromStatus).toBe('INITIAL_SENT');
    expect(events[0]?.toStatus).toBe('FOLLOW_UP_1_DUE');
    // The timeline must never imply a human made this transition.
    expect(events[0]?.data).toMatchObject({
      trigger: 'FOLLOWUP_DUE', automated: true, promotedBy: 'followup-automation', followupId: FOLLOWUP, step: 1,
    });
  });

  it('leaves the follow-up row and the due date completely untouched', async () => {
    const { store, service } = seed();
    await promote(service);

    const f = store.followups.get(FOLLOWUP);
    expect(f?.status).toBe('DUE');
    expect(f?.dueAt.getTime()).toBe(DUE);
    expect(f?.cancelledReason).toBeNull();
    // Promotion announces a due follow-up; it never moves one.
    expect(store.records.get(REC)?.nextFollowupAt?.getTime()).toBe(DUE);
    expect(store.records.get(REC)?.sequenceStep).toBe(0);
  });

  it('walks steps 2 and 3 from their own predecessor states', async () => {
    for (const [step, from, to] of [
      [2, 'FOLLOW_UP_1_SENT', 'FOLLOW_UP_2_DUE'],
      [3, 'FOLLOW_UP_2_SENT', 'FOLLOW_UP_3_DUE'],
    ] as const) {
      const { store, service } = seed({ record: { status: from as OutreachStatus }, followup: { step } });
      const r = await promote(service);
      expect(r.outcome).toBe('PROMOTED');
      expect(store.records.get(REC)?.status).toBe(to);
      expect(store.eventsFor(REC)[0]?.data).toMatchObject({ step });
    }
  });

  it('is idempotent: a second run finds the record already due and writes nothing', async () => {
    const { store, service } = seed();
    await promote(service);
    const again = await promote(service);

    expect(again.outcome).toBe('ALREADY_DUE');
    expect(store.records.get(REC)?.status).toBe('FOLLOW_UP_1_DUE');
    // Still exactly ONE transition in the immutable timeline.
    expect(store.eventsFor(REC)).toHaveLength(1);
  });

  it('re-decides against FRESH state: a reply that landed after listing blocks the promotion', async () => {
    const { store, service } = seed();
    // The worklist said INITIAL_SENT; by the time the write runs, reply sync has moved the record.
    store.records.set(REC, { ...store.records.get(REC)!, status: 'REPLIED_POSITIVE' });

    const r = await promote(service);
    expect(r.outcome).toBe('BLOCKED');
    expect(r.detail).toContain('REPLY_DETECTED');
    expect(store.records.get(REC)?.status).toBe('REPLIED_POSITIVE');
    expect(store.eventsFor(REC)).toEqual([]);
  });

  it('re-decides against FRESH state: a bounce blocks it, and a cancelled row is skipped', async () => {
    const bounced = seed({ record: { status: 'BOUNCED' } });
    expect((await promote(bounced.service)).outcome).toBe('BLOCKED');
    expect(bounced.store.eventsFor(REC)).toEqual([]);

    const cancelled = seed({ followup: { status: 'CANCELLED', cancelledReason: 'REPLY_DETECTED' } });
    const r = await promote(cancelled.service);
    expect(r.outcome).toBe('SKIPPED');
    expect(r.detail).toContain('FOLLOWUP_NOT_ACTIVE');
    expect(cancelled.store.records.get(REC)?.status).toBe('INITIAL_SENT');
    expect(cancelled.store.eventsFor(REC)).toEqual([]);
  });

  it('refuses a row that is not due yet, even when it is handed one directly', async () => {
    const { store, service } = seed({ followup: { dueAt: new Date(NOW + 3_600_000) } });
    const r = await promote(service);
    expect(r.outcome).toBe('SKIPPED');
    expect(r.detail).toContain('NOT_YET_DUE');
    expect(store.records.get(REC)?.status).toBe('INITIAL_SENT');
  });

  it('refuses a follow-up that belongs to a different record', async () => {
    const { store, service } = seed();
    const r = await service.promoteFollowupDue({
      followupId: FOLLOWUP, outreachRecordId: 'rec-other', actor: 'followup-automation',
    });
    expect(r.outcome).toBe('SKIPPED');
    expect(r.detail).toContain('FOLLOWUP_NOT_FOUND');
    expect(store.records.get(REC)?.status).toBe('INITIAL_SENT');
  });

  it('refuses a step mismatch rather than skipping an email in the sequence', async () => {
    const { store, service } = seed({ followup: { step: 2 } }); // record is still INITIAL_SENT
    const r = await promote(service);
    expect(r.outcome).toBe('SKIPPED');
    expect(r.detail).toContain('STATUS_MISMATCH');
    expect(store.records.get(REC)?.status).toBe('INITIAL_SENT');
    expect(store.eventsFor(REC)).toEqual([]);
  });
});

describe('promoteFollowupDue — concurrency', () => {
  it('loses the compare-and-set race without writing an event when another writer wins first', async () => {
    const { store, service } = seed();
    // Simulate the interleaving a second unattended run (or reply sync) would produce: the record
    // is re-read as INITIAL_SENT, but by the time the UPDATE runs the row has already moved on.
    const realGetRecord = store.getRecord.bind(store);
    store.getRecord = async (id: string) => {
      const rec = await realGetRecord(id);
      store.records.set(REC, { ...store.records.get(REC)!, status: 'FOLLOW_UP_1_DUE' });
      return rec;
    };

    const r = await promote(service);
    expect(r.outcome).toBe('RACE_LOST');
    // The winner's state stands, and the loser contributed nothing to the timeline.
    expect(store.records.get(REC)?.status).toBe('FOLLOW_UP_1_DUE');
    expect(store.eventsFor(REC)).toEqual([]);
  });

  it('two runs over the same due follow-up promote it exactly once', async () => {
    const { store, service } = seed();
    const results = await Promise.all([promote(service), promote(service)]);

    expect(results.filter((r) => r.outcome === 'PROMOTED')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'PROMOTED' || r.outcome === 'ALREADY_DUE' || r.outcome === 'RACE_LOST')).toHaveLength(2);
    expect(store.eventsFor(REC)).toHaveLength(1);
  });
});
