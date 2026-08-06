import { describe, expect, it } from 'vitest';

import {
  planRejectionPath,
  rejectLeadCommand,
  REJECTABLE_STATES,
} from '../../src/cli/commands/reject-lead.js';
import { LeadService, type LeadStore, type EventRecorder } from '../../src/domain/leads/lead-service.js';
import { type Lead } from '../../src/domain/leads/lead.js';
import { type LeadStatus } from '../../src/domain/leads/status.js';
import { type NewPipelineEvent } from '../../src/domain/pipeline/pipeline-event.js';
import { type CliContext } from '../../src/cli/context.js';

function makeLead(id: string, status: LeadStatus): Lead {
  return {
    id, businessName: null, normalizedName: null, domain: null, normalizedDomain: null,
    phone: null, normalizedPhone: null, formattedAddress: null, normalizedAddress: null,
    latitude: null, longitude: null, placeId: `place-${id}`, city: null, country: null,
    status, priority: null, source: 'google_places', dedupStatus: 'UNIQUE', duplicateOf: null,
    createdAt: new Date('2026-08-05T00:00:00Z'), updatedAt: new Date('2026-08-05T00:00:00Z'),
  };
}

class FakeStore implements LeadStore {
  constructor(private readonly leads: Map<string, Lead>) {}
  createCalls = 0;
  async create(): Promise<void> { this.createCalls += 1; }
  async getById(id: string): Promise<Lead | null> { return this.leads.get(id) ?? null; }
  async updateStatus(id: string, status: LeadStatus, updatedAt: Date): Promise<void> {
    const l = this.leads.get(id);
    if (l) this.leads.set(id, { ...l, status, updatedAt }); // append/replace projection; never deletes facts
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

describe('planRejectionPath', () => {
  it('rejects a direct-to-REJECTED state in one supported step', () => {
    expect(planRejectionPath('READY_FOR_QUALIFICATION')).toEqual(['REJECTED']);
    expect(planRejectionPath('NEEDS_MANUAL_REVIEW')).toEqual(['REJECTED']);
  });
  it('routes research-phase states through one NEEDS_MANUAL_REVIEW hop', () => {
    expect(planRejectionPath('READY_FOR_AUDIT')).toEqual(['NEEDS_MANUAL_REVIEW', 'REJECTED']);
    expect(planRejectionPath('READY_FOR_ENRICHMENT')).toEqual(['NEEDS_MANUAL_REVIEW', 'REJECTED']);
    expect(planRejectionPath('READY_FOR_CAPTURE')).toEqual(['NEEDS_MANUAL_REVIEW', 'REJECTED']);
    expect(planRejectionPath('AUDITED')).toEqual(['NEEDS_MANUAL_REVIEW', 'REJECTED']);
  });
  it('fails closed for contacted / sent / terminal / near-send / unknown-eligibility states', () => {
    for (const s of ['NEW', 'QUALIFIED', 'CAPTURED', 'OPPORTUNITY_READY', 'DRAFT_CREATED', 'SCHEDULED',
      'SENT', 'REPLIED', 'BOUNCED', 'UNSUBSCRIBED', 'REJECTED', 'DUPLICATE', 'FAILED'] as LeadStatus[]) {
      expect(() => planRejectionPath(s)).toThrow(/only pre-send states/);
    }
  });
  it('every returned step is a supported transition (no illegal edge)', () => {
    for (const s of REJECTABLE_STATES) expect(() => planRejectionPath(s)).not.toThrow();
  });
});

describe('rejectLeadCommand', () => {
  const LEAD = 'lead-under-audit';

  it('rejects one lead and records reason + operator on an immutable NOTE', async () => {
    const leads = new Map([[LEAD, makeLead(LEAD, 'READY_FOR_AUDIT')]]);
    const { ctx, store, events } = buildCtx(leads);
    await rejectLeadCommand(ctx, { lead: LEAD, reason: 'NO_MATERIAL_VERIFIED_ISSUE', by: 'Adi' });

    expect((await store.getById(LEAD))?.status).toBe('REJECTED');
    const types = events.events.map((e) => e.type);
    expect(types).toEqual(['STATE_TRANSITION', 'STATE_TRANSITION', 'NOTE']); // MNR hop, REJECTED, note
    const note = events.events.at(-1)!;
    expect(note.message).toContain('NO_MATERIAL_VERIFIED_ISSUE');
    expect(note.message).toContain('Adi');
    expect(note.data).toMatchObject({ reason: 'NO_MATERIAL_VERIFIED_ISSUE', operator: 'Adi', fromState: 'READY_FOR_AUDIT' });
  });

  it('preserves history (append-only) and creates no suppression/outreach/email/gmail event', async () => {
    const leads = new Map([[LEAD, makeLead(LEAD, 'READY_FOR_AUDIT')]]);
    const { ctx, store, events } = buildCtx(leads);
    await rejectLeadCommand(ctx, { lead: LEAD, reason: 'NO_MATERIAL_VERIFIED_ISSUE', by: 'Adi' });
    // only lead-lifecycle events; no deletes; store.create never called (no fabricated records)
    expect(store.createCalls).toBe(0);
    expect(events.events.every((e) => ['STATE_TRANSITION', 'NOTE'].includes(e.type))).toBe(true);
    expect(events.events.every((e) => e.leadId === LEAD)).toBe(true);
  });

  it('fails closed for an ineligible (already-sent) state and changes nothing', async () => {
    const leads = new Map([[LEAD, makeLead(LEAD, 'SENT')]]);
    const { ctx, store, events } = buildCtx(leads);
    await expect(rejectLeadCommand(ctx, { lead: LEAD, reason: 'x', by: 'Adi' })).rejects.toThrow(/only pre-send states/);
    expect((await store.getById(LEAD))?.status).toBe('SENT');
    expect(events.events).toHaveLength(0);
  });

  it('fails closed for an unknown lead id', async () => {
    const { ctx, events } = buildCtx(new Map());
    await expect(rejectLeadCommand(ctx, { lead: 'nope', reason: 'x', by: 'Adi' })).rejects.toThrow(/not found/);
    expect(events.events).toHaveLength(0);
  });

  it('requires lead, reason and operator (no bulk / no silent defaults)', async () => {
    const { ctx } = buildCtx(new Map([[LEAD, makeLead(LEAD, 'READY_FOR_AUDIT')]]));
    await expect(rejectLeadCommand(ctx, { reason: 'x', by: 'Adi' })).rejects.toThrow(/--lead/);
    await expect(rejectLeadCommand(ctx, { lead: LEAD, by: 'Adi' })).rejects.toThrow(/--reason/);
    await expect(rejectLeadCommand(ctx, { lead: LEAD, reason: 'x' })).rejects.toThrow(/--by/);
  });

  it('touches only the named lead (no bulk fallback)', async () => {
    const leads = new Map([
      [LEAD, makeLead(LEAD, 'READY_FOR_AUDIT')],
      ['other-lead', makeLead('other-lead', 'READY_FOR_AUDIT')],
    ]);
    const { ctx, store } = buildCtx(leads);
    await rejectLeadCommand(ctx, { lead: LEAD, reason: 'NO_MATERIAL_VERIFIED_ISSUE', by: 'Adi' });
    expect((await store.getById(LEAD))?.status).toBe('REJECTED');
    expect((await store.getById('other-lead'))?.status).toBe('READY_FOR_AUDIT'); // untouched
  });
});
