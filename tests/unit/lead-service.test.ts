import { describe, expect, it } from 'vitest';
import {
  type EventRecorder,
  LeadService,
  type LeadStore,
} from '../../src/domain/leads/lead-service.js';
import { type Lead } from '../../src/domain/leads/lead.js';
import { type NewPipelineEvent } from '../../src/domain/pipeline/pipeline-event.js';
import { type LeadStatus } from '../../src/domain/leads/status.js';
import { AppError, InvalidStateTransitionError } from '../../src/utils/errors.js';

class FakeStore implements LeadStore {
  readonly leads = new Map<string, Lead>();

  async create(lead: Lead): Promise<void> {
    this.leads.set(lead.id, lead);
  }
  async getById(id: string): Promise<Lead | null> {
    return this.leads.get(id) ?? null;
  }
  async updateStatus(id: string, status: LeadStatus, updatedAt: Date): Promise<void> {
    const existing = this.leads.get(id);
    if (existing) this.leads.set(id, { ...existing, status, updatedAt });
  }
}

class FakeRecorder implements EventRecorder {
  readonly events: NewPipelineEvent[] = [];
  async record(event: NewPipelineEvent): Promise<void> {
    this.events.push(event);
  }
}

function makeService(): { service: LeadService; store: FakeStore; recorder: FakeRecorder } {
  const store = new FakeStore();
  const recorder = new FakeRecorder();
  return { service: new LeadService(store, recorder), store, recorder };
}

describe('LeadService.createLead', () => {
  it('creates a NEW lead and records a LEAD_CREATED event', async () => {
    const { service, store, recorder } = makeService();
    const lead = await service.createLead({ businessName: 'Acme Dental', domain: 'www.acme.test' });

    expect(lead.status).toBe('NEW');
    expect(lead.normalizedName).toBe('acme dental');
    expect(lead.normalizedDomain).toBe('acme.test');
    expect(store.leads.size).toBe(1);
    expect(recorder.events).toHaveLength(1);
    expect(recorder.events[0]?.type).toBe('LEAD_CREATED');
  });
});

describe('LeadService.transition', () => {
  it('applies a valid transition and records STATE_TRANSITION', async () => {
    const { service, store, recorder } = makeService();
    const lead = await service.createLead({ businessName: 'Acme Dental' });

    const updated = await service.transition(lead.id, 'NORMALIZED');

    expect(updated.status).toBe('NORMALIZED');
    expect(store.leads.get(lead.id)?.status).toBe('NORMALIZED');
    const transitionEvents = recorder.events.filter((e) => e.type === 'STATE_TRANSITION');
    expect(transitionEvents).toHaveLength(1);
    expect(transitionEvents[0]?.fromStatus).toBe('NEW');
    expect(transitionEvents[0]?.toStatus).toBe('NORMALIZED');
  });

  it('rejects an invalid transition, records an audit event, and leaves status unchanged', async () => {
    const { service, store, recorder } = makeService();
    const lead = await service.createLead({ businessName: 'Acme Dental' });

    await expect(service.transition(lead.id, 'SENT')).rejects.toBeInstanceOf(
      InvalidStateTransitionError,
    );

    expect(store.leads.get(lead.id)?.status).toBe('NEW');
    const invalid = recorder.events.filter((e) => e.type === 'INVALID_TRANSITION');
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.fromStatus).toBe('NEW');
    expect(invalid[0]?.toStatus).toBe('SENT');
  });

  it('throws AppError when the lead does not exist', async () => {
    const { service } = makeService();
    await expect(service.transition('missing-id', 'NORMALIZED')).rejects.toBeInstanceOf(AppError);
  });
});
