import { AppError, InvalidStateTransitionError } from '../../utils/errors.js';
import { type NewPipelineEvent } from '../pipeline/pipeline-event.js';
import { buildLeadFromFacts } from './lead-factory.js';
import { type Lead, type NewLead, newLeadSchema } from './lead.js';
import { canTransition } from './state-machine.js';
import { type LeadStatus } from './status.js';

/** Persistence port for leads — implemented by LeadsRepository, faked in tests. */
export interface LeadStore {
  create(lead: Lead): Promise<void>;
  getById(id: string): Promise<Lead | null>;
  updateStatus(id: string, status: LeadStatus, updatedAt: Date): Promise<void>;
}

/** Audit port — implemented by PipelineRepository, faked in tests. */
export interface EventRecorder {
  record(event: NewPipelineEvent): Promise<void>;
}

/**
 * Owns the two write operations of the deterministic core: creating a lead and
 * transitioning its state. Both always produce an audit event; invalid transitions
 * are recorded *and* rejected. All external effects go through injected ports.
 */
export class LeadService {
  constructor(
    private readonly store: LeadStore,
    private readonly events: EventRecorder,
  ) {}

  async createLead(input: NewLead): Promise<Lead> {
    const parsed = newLeadSchema.parse(input);
    const lead = buildLeadFromFacts(
      {
        businessName: parsed.businessName,
        domain: parsed.domain,
        phone: parsed.phone,
        city: parsed.city,
        country: parsed.country,
        formattedAddress: parsed.formattedAddress,
        latitude: parsed.latitude,
        longitude: parsed.longitude,
      },
      { source: parsed.source ?? 'mock', placeId: parsed.placeId },
    );

    await this.store.create(lead);
    await this.events.record({
      leadId: lead.id,
      runId: null,
      type: 'LEAD_CREATED',
      fromStatus: null,
      toStatus: 'NEW',
      message: `Lead created: ${lead.businessName}`,
      data: null,
    });
    return lead;
  }

  /**
   * Transition a lead to a new state. On an illegal transition an INVALID_TRANSITION
   * audit event is written and {@link InvalidStateTransitionError} is thrown — the
   * lead's status is never changed.
   */
  async transition(leadId: string, to: LeadStatus): Promise<Lead> {
    const lead = await this.store.getById(leadId);
    if (!lead) {
      throw new AppError('LEAD_NOT_FOUND', `Lead not found: ${leadId}`);
    }
    const from = lead.status;

    if (!canTransition(from, to)) {
      await this.events.record({
        leadId,
        runId: null,
        type: 'INVALID_TRANSITION',
        fromStatus: from,
        toStatus: to,
        message: `Rejected invalid transition ${from} -> ${to}`,
        data: null,
      });
      throw new InvalidStateTransitionError(from, to);
    }

    const now = new Date();
    await this.store.updateStatus(leadId, to, now);
    await this.events.record({
      leadId,
      runId: null,
      type: 'STATE_TRANSITION',
      fromStatus: from,
      toStatus: to,
      message: `${from} -> ${to}`,
      data: null,
    });
    return { ...lead, status: to, updatedAt: now };
  }
}
