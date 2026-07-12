import { type DedupCandidate, type DedupInput } from '../domain/leads/dedup.js';
import { type DedupStatus, type Lead } from '../domain/leads/lead.js';
import { type NewSourceEntity, type SourceEntity } from '../domain/lead-sources/source-entity.js';
import { type NewSourceObservation } from '../domain/lead-sources/source-observation.js';
import { type NewSourceRequest } from '../domain/lead-sources/source-request.js';
import { type NewPipelineEvent } from '../domain/pipeline/pipeline-event.js';

/** Records one API request/page. Written outside the per-candidate transaction. */
export interface SourceRequestStore {
  record(req: NewSourceRequest): Promise<string>;
}

/** Transaction-scoped lead operations used during collection. */
export interface TxLeadStore {
  create(lead: Lead): Promise<void>;
  findDedupCandidates(input: DedupInput): Promise<DedupCandidate[]>;
  setDedupStatus(id: string, status: DedupStatus, duplicateOf: string | null): Promise<void>;
}

export interface TxEntityStore {
  findByProviderPlaceId(provider: string, sourcePlaceId: string): Promise<SourceEntity | null>;
  create(entity: NewSourceEntity): Promise<SourceEntity>;
  touchLastSeen(id: string, when: Date): Promise<void>;
}

export interface TxObservationStore {
  create(observation: NewSourceObservation): Promise<void>;
}

export interface TxEventRecorder {
  record(event: NewPipelineEvent): Promise<void>;
}

export interface CollectTxRepos {
  leads: TxLeadStore;
  entities: TxEntityStore;
  observations: TxObservationStore;
  events: TxEventRecorder;
}

/**
 * Runs a function inside a single atomic transaction. If the function throws, all
 * writes roll back. Implemented by the Drizzle unit-of-work (real transaction) and
 * by an in-memory fake (snapshot/restore) for tests.
 */
export interface UnitOfWork {
  transaction<T>(fn: (repos: CollectTxRepos) => Promise<T>): Promise<T>;
}
