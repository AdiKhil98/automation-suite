import { type LeadFactsInput } from '../../domain/leads/lead-factory.js';
import {
  type CollectQuery,
  type LeadSourceProvider,
  type ProviderCaps,
  type ProviderPage,
  type RawCandidate,
} from './provider.js';

/** A mock business record: full facts (this is synthetic test data, not Google content). */
export interface MockBusiness extends LeadFactsInput {
  sourcePlaceId: string;
}

/**
 * Default provider. Paginates a fixed in-memory dataset so the full pipeline and
 * dedup engine can be exercised deterministically with no network or paid calls.
 */
export class MockLeadSource implements LeadSourceProvider {
  readonly name = 'mock';

  constructor(private readonly businesses: MockBusiness[]) {}

  async *pages(_query: CollectQuery, caps: ProviderCaps): AsyncGenerator<ProviderPage> {
    const pageSize = Math.max(1, caps.pageSize);
    const totalPages = Math.min(caps.maxPages, Math.ceil(this.businesses.length / pageSize) || 1);

    for (let pageIndex = 0; pageIndex < totalPages; pageIndex += 1) {
      const slice = this.businesses.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);
      const candidates: RawCandidate[] = slice.map((b) => ({
        sourcePlaceId: b.sourcePlaceId,
        facts: {
          businessName: b.businessName,
          domain: b.domain,
          phone: b.phone,
          city: b.city,
          country: b.country,
          formattedAddress: b.formattedAddress,
          latitude: b.latitude,
          longitude: b.longitude,
        },
      }));
      const now = new Date();
      yield {
        candidates,
        request: {
          fieldMask: 'mock',
          pageIndex,
          query: { textQuery: _query.textQuery, pageSize },
          resultCount: candidates.length,
          billedTier: null,
          estimatedCostUsd: 0,
          status: candidates.length > 0 ? 'OK' : 'EMPTY',
          startedAt: now,
          completedAt: now,
        },
      };
      if (slice.length < pageSize) break;
    }
  }
}
