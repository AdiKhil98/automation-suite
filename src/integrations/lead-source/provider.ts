import { type LeadFactsInput } from '../../domain/leads/lead-factory.js';
import { type RequestStatus } from '../../domain/lead-sources/source-request.js';

/**
 * A candidate returned by a provider. Google discovery yields `facts: null` (Place
 * ID only). Mock/manual providers yield full facts for testing the dedup engine.
 */
export interface RawCandidate {
  sourcePlaceId: string;
  facts: LeadFactsInput | null;
}

/** Per-request accounting emitted by a provider (cost is recorded once per request). */
export interface ProviderRequestMeta {
  fieldMask: string;
  pageIndex: number;
  query: unknown;
  resultCount: number;
  billedTier: string | null;
  estimatedCostUsd: number | null;
  status: RequestStatus;
  startedAt: Date;
  completedAt: Date | null;
}

export interface ProviderPage {
  candidates: RawCandidate[];
  request: ProviderRequestMeta;
}

export interface CollectQuery {
  textQuery: string;
  locationBias?: unknown;
}

export interface ProviderCaps {
  pageSize: number;
  maxPages: number;
}

/** A source of candidate businesses. Implementations: MockLeadSource, GooglePlacesProvider. */
export interface LeadSourceProvider {
  readonly name: string;
  pages(query: CollectQuery, caps: ProviderCaps): AsyncGenerator<ProviderPage>;
}
