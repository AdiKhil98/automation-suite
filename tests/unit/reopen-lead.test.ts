import { describe, expect, it } from 'vitest';

import {
  reopenLeadCommand,
  REOPENABLE_STATE,
} from '../../src/cli/commands/reopen-lead.js';
import { LeadService, type LeadStore, type EventRecorder } from '../../src/domain/leads/lead-service.js';
import { type Lead } from '../../src/domain/leads/lead.js';
import { type LeadStatus } from '../../src/domain/leads/status.js';
import { type NewPipelineEvent } from '../../src/domain/pipeline/pipeline-event.js';
import { type CliContext } from '../../src/cli/context.js';

function makeLead(id: string, status: LeadStatus): Lead {
  return {
    id, businessName: 'Mayfield Dental', normalizedName: 'mayfield dental', domain: null, normalizedDomain: null,
    phone: null, normalizedPhone: null, formattedAddress: null, normalizedAddress: null,
    latitude: null, longitude: null, placeId: `place-${id}`, city: null, country: null,
    status, priority: null, source: 'google_places', dedupStatus: 'UNIQUE', duplicateOf: null,
    createdAt: new Date('2026-08-05T00:00:00Z'), updatedAt: new Date('2026-08-05T00:00:00Z'),
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

function buildCtx(leads: Map<string, Lead>): { ctx: CliContext; store: FakeStore; events: FakeEvents } {
  const store = new FakeStore(leads);
  const events = new FakeEvents();
  const service = new LeadService(store, events);
  const ctx = { leads: { getById: (id: string) => store.getById(id) }, service, events } as unknown as CliContext;
  return { ctx, store, events };
}

const LEAD = 'mayfield-dental';
const REASON = 'FALSE_REJECTION_CATEGORY_NORMALIZATION_BUG_FIXED_IN_94BD57C';

describe('reopenLeadCommand', () => {
  it('only allows reopening from REJECTED', () => {
    expect(REOPENABLE_STATE).toBe('REJECTED');
  });

  it('reopens one REJECTED lead to NEEDS_MANUAL_REVIEW and records an immutable correction NOTE', async () => {
    const leads = new Map([[LEAD, makeLead(LEAD, 'REJECTED')]]);
    const { ctx, store, events } = buildCtx(leads);
    await reopenLeadCommand(ctx, { lead: LEAD, reason: REASON, by: 'Adi' });

    expect((await store.getById(LEAD))?.status).toBe('NEEDS_MANUAL_REVIEW');
    const types = events.events.map((e) => e.type);
    expect(types).toEqual(['STATE_TRANSITION', 'NOTE']); // reopen transition, then correction note
    const note = events.events.at(-1)!;
    expect(note.message).toContain(REASON);
    expect(note.message).toContain('Adi');
    expect(note.fromStatus).toBe('REJECTED');
    expect(note.toStatus).toBe('NEEDS_MANUAL_REVIEW');
    expect(note.data).toMatchObject({ reason: REASON, operator: 'Adi', correction: true, fromState: 'REJECTED' });
  });

  it('preserves the original rejection and history (append-only; no fabricated or destructive writes)', async () => {
    const leads = new Map([[LEAD, makeLead(LEAD, 'REJECTED')]]);
    const { ctx, store, events } = buildCtx(leads);
    await reopenLeadCommand(ctx, { lead: LEAD, reason: REASON, by: 'Adi' });
    // store.create never called (no fabricated lead); only a single status projection update
    expect(store.createCalls).toBe(0);
    expect(store.updateCalls).toEqual([{ id: LEAD, status: 'NEEDS_MANUAL_REVIEW' }]);
    // only lead-lifecycle events, all for this lead; nothing deleted (append-only recorder)
    expect(events.events.every((e) => ['STATE_TRANSITION', 'NOTE'].includes(e.type))).toBe(true);
    expect(events.events.every((e) => e.leadId === LEAD)).toBe(true);
  });

  it('creates no suppression / outreach / email / gmail / sheet / competitor side effects', async () => {
    const leads = new Map([[LEAD, makeLead(LEAD, 'REJECTED')]]);
    const { ctx, events } = buildCtx(leads);
    await reopenLeadCommand(ctx, { lead: LEAD, reason: REASON, by: 'Adi' });
    const sideEffectTypes = ['SUPPRESSION', 'OUTREACH', 'EMAIL', 'GMAIL', 'SHEET', 'COMPETITOR', 'SEND'];
    expect(events.events.some((e) => sideEffectTypes.some((t) => e.type.includes(t)))).toBe(false);
  });

  it('fails closed for a non-REJECTED lead and changes nothing', async () => {
    for (const state of ['READY_FOR_QUALIFICATION', 'AUDITED', 'SENT', 'UNSUBSCRIBED', 'DUPLICATE', 'NEEDS_MANUAL_REVIEW'] as LeadStatus[]) {
      const leads = new Map([[LEAD, makeLead(LEAD, state)]]);
      const { ctx, store, events } = buildCtx(leads);
      await expect(reopenLeadCommand(ctx, { lead: LEAD, reason: REASON, by: 'Adi' }))
        .rejects.toThrow(/only a REJECTED lead can be reopened/);
      expect((await store.getById(LEAD))?.status).toBe(state);
      expect(events.events).toHaveLength(0);
    }
  });

  it('fails closed for an unknown lead id', async () => {
    const { ctx, events } = buildCtx(new Map());
    await expect(reopenLeadCommand(ctx, { lead: 'nope', reason: REASON, by: 'Adi' })).rejects.toThrow(/not found/);
    expect(events.events).toHaveLength(0);
  });

  it('requires lead, reason and operator (no bulk / no silent defaults)', async () => {
    const { ctx } = buildCtx(new Map([[LEAD, makeLead(LEAD, 'REJECTED')]]));
    await expect(reopenLeadCommand(ctx, { reason: REASON, by: 'Adi' })).rejects.toThrow(/--lead/);
    await expect(reopenLeadCommand(ctx, { lead: LEAD, by: 'Adi' })).rejects.toThrow(/--reason/);
    await expect(reopenLeadCommand(ctx, { lead: LEAD, reason: REASON })).rejects.toThrow(/--by/);
    await expect(reopenLeadCommand(ctx, { lead: '  ', reason: REASON, by: 'Adi' })).rejects.toThrow(/--lead/);
  });

  it('touches only the named lead (no bulk fallback)', async () => {
    const leads = new Map([
      [LEAD, makeLead(LEAD, 'REJECTED')],
      ['other-lead', makeLead('other-lead', 'REJECTED')],
    ]);
    const { ctx, store } = buildCtx(leads);
    await reopenLeadCommand(ctx, { lead: LEAD, reason: REASON, by: 'Adi' });
    expect((await store.getById(LEAD))?.status).toBe('NEEDS_MANUAL_REVIEW');
    expect((await store.getById('other-lead'))?.status).toBe('REJECTED'); // untouched
  });
});
