import { describe, expect, it } from 'vitest';

import {
  requeueLeadForAuditCommand,
  REQUEUEABLE_STATE,
  REQUEUE_TARGET,
  REQUEUE_RECOVERY_TYPE,
} from '../../src/cli/commands/requeue-lead-for-audit.js';
import { type LeadRequeueTxRepos, type LeadRequeueUnitOfWork } from '../../src/persistence/lead-requeue-unit-of-work.js';
import { LeadService, type LeadStore, type EventRecorder } from '../../src/domain/leads/lead-service.js';
import { type Lead } from '../../src/domain/leads/lead.js';
import { type LeadStatus } from '../../src/domain/leads/status.js';
import { type NewPipelineEvent } from '../../src/domain/pipeline/pipeline-event.js';
import { type CliContext } from '../../src/cli/context.js';
import { AppError } from '../../src/utils/errors.js';

function makeLead(id: string, status: LeadStatus): Lead {
  return {
    id, businessName: 'Dentistry on Gipsy Hill', normalizedName: 'dentistry on gipsy hill', domain: null,
    normalizedDomain: null, phone: null, normalizedPhone: null, formattedAddress: null, normalizedAddress: null,
    latitude: null, longitude: null, placeId: 'place-' + id, city: null, country: null,
    status, priority: null, source: 'google_places', dedupStatus: 'UNIQUE', duplicateOf: null,
    createdAt: new Date('2026-09-01T00:00:00Z'), updatedAt: new Date('2026-09-01T00:00:00Z'),
  };
}

class FakeStore implements LeadStore {
  constructor(private readonly leads: Map<string, Lead>) {}
  createCalls = 0;
  updateCalls: { id: string; status: LeadStatus }[] = [];
  async create(): Promise<void> { this.createCalls += 1; }
  async getById(id: string): Promise<Lead | null> { return this.leads.get(id) ?? null; }
  async updateStatus(id: string, status: LeadStatus, updatedAt: Date): Promise<void> {
    this.updateCalls.push({ id, status });
    const l = this.leads.get(id);
    if (l) this.leads.set(id, { ...l, status, updatedAt }); // projection only; never deletes facts
  }
}

class FakeEvents implements EventRecorder {
  events: NewPipelineEvent[] = [];
  async record(e: NewPipelineEvent): Promise<void> { this.events.push(e); }
}

/** Fake UoW mirroring the Drizzle one: discards writes (rolls back) if the callback throws. */
class FakeUow implements LeadRequeueUnitOfWork {
  committed = false;
  rolledBack = false;
  constructor(private readonly repos: LeadRequeueTxRepos) {}
  async transaction<T>(fn: (repos: LeadRequeueTxRepos) => Promise<T>): Promise<T> {
    try {
      const out = await fn(this.repos);
      this.committed = true;
      return out;
    } catch (err) {
      this.rolledBack = true;
      throw err;
    }
  }
}

function build(leads: Map<string, Lead>): { ctx: CliContext; store: FakeStore; events: FakeEvents; uow: FakeUow } {
  const store = new FakeStore(leads);
  const events = new FakeEvents();
  const leadService = new LeadService(store, events);
  const uow = new FakeUow({ leads: store, leadService, events } as unknown as LeadRequeueTxRepos);
  const ctx = { db: {} } as unknown as CliContext;
  return { ctx, store, events, uow };
}

const LEAD = 'gipsy-hill-dental';
const REASON = 'Requeue after deployed fix for false-positive placeholder audit validation';
const BY = 'operator';

describe('requeueLeadForAuditCommand', () => {
  it('only allows requeue from NEEDS_MANUAL_REVIEW into READY_FOR_AUDIT', () => {
    expect(REQUEUEABLE_STATE).toBe('NEEDS_MANUAL_REVIEW');
    expect(REQUEUE_TARGET).toBe('READY_FOR_AUDIT');
    expect(REQUEUE_RECOVERY_TYPE).toBe('audit_requeue');
  });

  it('requeues one NEEDS_MANUAL_REVIEW lead and records STATE_TRANSITION then the recovery NOTE', async () => {
    const leads = new Map([[LEAD, makeLead(LEAD, 'NEEDS_MANUAL_REVIEW')]]);
    const { ctx, store, events, uow } = build(leads);
    await requeueLeadForAuditCommand(ctx, { lead: LEAD, reason: REASON, by: BY }, uow);

    expect((await store.getById(LEAD))?.status).toBe('READY_FOR_AUDIT');
    expect(events.events.map((e) => e.type)).toEqual(['STATE_TRANSITION', 'NOTE']);
    expect(uow.committed).toBe(true);
  });

  it('records the STATE_TRANSITION event with the correct edge', async () => {
    const leads = new Map([[LEAD, makeLead(LEAD, 'NEEDS_MANUAL_REVIEW')]]);
    const { ctx, events, uow } = build(leads);
    await requeueLeadForAuditCommand(ctx, { lead: LEAD, reason: REASON, by: BY }, uow);

    const transition = events.events[0]!;
    expect(transition.type).toBe('STATE_TRANSITION');
    expect(transition.fromStatus).toBe('NEEDS_MANUAL_REVIEW');
    expect(transition.toStatus).toBe('READY_FOR_AUDIT');
  });

  it('records an immutable recovery NOTE with reason, operator, recovery type, and both statuses', async () => {
    const leads = new Map([[LEAD, makeLead(LEAD, 'NEEDS_MANUAL_REVIEW')]]);
    const { ctx, events, uow } = build(leads);
    await requeueLeadForAuditCommand(ctx, { lead: LEAD, reason: REASON, by: BY }, uow);

    const note = events.events.at(-1)!;
    expect(note.type).toBe('NOTE');
    expect(note.message).toContain(REASON);
    expect(note.message).toContain(BY);
    expect(note.fromStatus).toBe('NEEDS_MANUAL_REVIEW');
    expect(note.toStatus).toBe('READY_FOR_AUDIT');
    expect(note.data).toMatchObject({
      reason: REASON,
      operator: BY,
      recoveryType: REQUEUE_RECOVERY_TYPE,
      fromState: 'NEEDS_MANUAL_REVIEW',
      toState: 'READY_FOR_AUDIT',
    });
  });

  it.each([
    'READY_FOR_AUDIT', 'AUDITED', 'OPPORTUNITY_READY', 'REJECTED', 'SENT', 'EMAIL_DRAFTED', 'NEW',
  ] as LeadStatus[])('fails closed from wrong source status: %s', async (status) => {
    const leads = new Map([[LEAD, makeLead(LEAD, status)]]);
    const { ctx, store, events, uow } = build(leads);
    await expect(requeueLeadForAuditCommand(ctx, { lead: LEAD, reason: REASON, by: BY }, uow))
      .rejects.toMatchObject({ code: 'LEAD_NOT_REQUEUEABLE' });

    expect((await store.getById(LEAD))?.status).toBe(status); // unchanged
    expect(store.updateCalls).toEqual([]);
    expect(events.events).toEqual([]); // no transition, no note
    expect(uow.rolledBack).toBe(true);
  });

  it('fails closed for a missing lead', async () => {
    const { ctx, store, events, uow } = build(new Map());
    await expect(requeueLeadForAuditCommand(ctx, { lead: 'does-not-exist', reason: REASON, by: BY }, uow))
      .rejects.toMatchObject({ code: 'LEAD_NOT_FOUND' });

    expect(store.updateCalls).toEqual([]);
    expect(events.events).toEqual([]);
    expect(uow.rolledBack).toBe(true);
  });

  it.each([
    [{ reason: REASON, by: BY }, 'LEAD_REQUIRED'],
    [{ lead: LEAD, by: BY }, 'REASON_REQUIRED'],
    [{ lead: LEAD, reason: REASON }, 'OPERATOR_REQUIRED'],
    [{ lead: '  ', reason: REASON, by: BY }, 'LEAD_REQUIRED'],
    [{ lead: LEAD, reason: '   ', by: BY }, 'REASON_REQUIRED'],
    [{ lead: LEAD, reason: REASON, by: '   ' }, 'OPERATOR_REQUIRED'],
  ])('rejects under-specified input (case %#)', async (opts, code) => {
    const leads = new Map([[LEAD, makeLead(LEAD, 'NEEDS_MANUAL_REVIEW')]]);
    const { ctx, store, events, uow } = build(leads);
    await expect(requeueLeadForAuditCommand(ctx, opts, uow)).rejects.toBeInstanceOf(AppError);
    await expect(requeueLeadForAuditCommand(ctx, opts, uow)).rejects.toMatchObject({ code });

    expect((await store.getById(LEAD))?.status).toBe('NEEDS_MANUAL_REVIEW'); // untouched
    expect(store.updateCalls).toEqual([]);
    expect(events.events).toEqual([]);
    expect(uow.committed).toBe(false); // validation happens before the transaction opens
  });

  it('is append-only: never creates a lead and makes exactly one status projection write', async () => {
    const leads = new Map([[LEAD, makeLead(LEAD, 'NEEDS_MANUAL_REVIEW')]]);
    const { ctx, store, events, uow } = build(leads);
    await requeueLeadForAuditCommand(ctx, { lead: LEAD, reason: REASON, by: BY }, uow);

    expect(store.createCalls).toBe(0);
    expect(store.updateCalls).toEqual([{ id: LEAD, status: 'READY_FOR_AUDIT' }]);
    expect(events.events.every((e) => e.leadId === LEAD)).toBe(true);
    expect(events.events.every((e) => ['STATE_TRANSITION', 'NOTE'].includes(e.type))).toBe(true);
  });
});
