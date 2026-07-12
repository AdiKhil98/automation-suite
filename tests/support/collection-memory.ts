import { randomUUID } from 'node:crypto';
import { type DedupCandidate, type DedupInput } from '../../src/domain/leads/dedup.js';
import { type DedupStatus, type Lead } from '../../src/domain/leads/lead.js';
import { type NewSourceEntity, type SourceEntity } from '../../src/domain/lead-sources/source-entity.js';
import { type NewSourceObservation } from '../../src/domain/lead-sources/source-observation.js';
import { type NewSourceRequest } from '../../src/domain/lead-sources/source-request.js';
import { type NewPipelineEvent } from '../../src/domain/pipeline/pipeline-event.js';
import {
  type CollectTxRepos,
  type SourceRequestStore,
  type UnitOfWork,
} from '../../src/pipeline/ports.js';

/**
 * In-memory implementation of the collection ports for fast, DB-free pipeline
 * tests. The unit of work snapshots and restores state so a thrown callback
 * behaves like a rolled-back transaction.
 */
export class InMemoryCollectionStore implements UnitOfWork, SourceRequestStore {
  leads = new Map<string, Lead>();
  entities = new Map<string, SourceEntity>();
  observations: NewSourceObservation[] = [];
  events: NewPipelineEvent[] = [];
  requests: NewSourceRequest[] = [];

  async record(req: NewSourceRequest): Promise<string> {
    this.requests.push(req);
    return randomUUID();
  }

  private repos(): CollectTxRepos {
    return {
      leads: {
        create: async (lead: Lead): Promise<void> => {
          this.leads.set(lead.id, lead);
        },
        findDedupCandidates: async (input: DedupInput): Promise<DedupCandidate[]> => {
          const out: DedupCandidate[] = [];
          for (const lead of this.leads.values()) {
            if (lead.dedupStatus !== 'UNIQUE') continue;
            const match =
              (input.normalizedDomain != null && lead.normalizedDomain === input.normalizedDomain) ||
              (input.normalizedPhone != null && lead.normalizedPhone === input.normalizedPhone) ||
              (input.normalizedName != null && lead.normalizedName === input.normalizedName);
            if (match) {
              out.push({
                leadId: lead.id,
                normalizedName: lead.normalizedName,
                normalizedDomain: lead.normalizedDomain,
                normalizedPhone: lead.normalizedPhone,
                normalizedAddress: lead.normalizedAddress,
                latitude: lead.latitude,
                longitude: lead.longitude,
                city: lead.city,
              });
            }
          }
          return out;
        },
        setDedupStatus: async (id: string, status: DedupStatus, duplicateOf: string | null): Promise<void> => {
          const lead = this.leads.get(id);
          if (lead) this.leads.set(id, { ...lead, dedupStatus: status, duplicateOf });
        },
      },
      entities: {
        findByProviderPlaceId: async (
          provider: string,
          sourcePlaceId: string,
        ): Promise<SourceEntity | null> => {
          for (const e of this.entities.values()) {
            if (e.provider === provider && e.sourcePlaceId === sourcePlaceId) return e;
          }
          return null;
        },
        create: async (entity: NewSourceEntity): Promise<SourceEntity> => {
          const now = new Date();
          const created: SourceEntity = { id: randomUUID(), ...entity, firstSeenAt: now, lastSeenAt: now };
          this.entities.set(created.id, created);
          return created;
        },
        touchLastSeen: async (id: string, when: Date): Promise<void> => {
          const e = this.entities.get(id);
          if (e) this.entities.set(id, { ...e, lastSeenAt: when });
        },
      },
      observations: {
        create: async (observation: NewSourceObservation): Promise<void> => {
          this.observations.push(observation);
        },
      },
      events: {
        record: async (event: NewPipelineEvent): Promise<void> => {
          this.events.push(event);
        },
      },
    };
  }

  async transaction<T>(fn: (repos: CollectTxRepos) => Promise<T>): Promise<T> {
    const snapshot = {
      leads: new Map(this.leads),
      entities: new Map(this.entities),
      observations: [...this.observations],
      events: [...this.events],
    };
    try {
      return await fn(this.repos());
    } catch (err) {
      this.leads = snapshot.leads;
      this.entities = snapshot.entities;
      this.observations = snapshot.observations;
      this.events = snapshot.events;
      throw err;
    }
  }
}
