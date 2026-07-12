import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { collectLeads, type CollectOptions } from '../../src/pipeline/collect-leads.js';
import { MockLeadSource, type MockBusiness } from '../../src/integrations/lead-source/mock-lead-source.js';
import {
  type CollectQuery,
  type LeadSourceProvider,
  type ProviderCaps,
  type ProviderPage,
} from '../../src/integrations/lead-source/provider.js';
import { InMemoryCollectionStore } from '../support/collection-memory.js';

const logger = pino({ level: 'silent' });

function business(id: string, over: Partial<MockBusiness> = {}): MockBusiness {
  // Distinct domain/phone/address/coords per id so records don't accidentally dedup.
  const n = id.charCodeAt(0);
  return {
    sourcePlaceId: id,
    businessName: `Biz ${id}`,
    domain: `${id}.example`,
    phone: `0161 496 ${String(1000 + n).slice(-4)}`,
    city: 'Manchester',
    country: 'GB',
    formattedAddress: `${id} High Street, Manchester`,
    latitude: 53.48 + n * 0.01,
    longitude: -2.24 + n * 0.01,
    ...over,
  };
}

function opts(over: Partial<CollectOptions> = {}): CollectOptions {
  return {
    runId: 'run-1',
    campaign: 'test',
    query: { textQuery: 'dentist' },
    caps: { maxLeads: 100, pageSize: 20, maxPages: 5 },
    nearMeters: 40,
    factsSource: 'mock',
    ...over,
  };
}

describe('collectLeads', () => {
  it('creates unique leads and is idempotent on rerun', async () => {
    const store = new InMemoryCollectionStore();
    const provider = new MockLeadSource([business('a'), business('b'), business('c')]);

    const first = await collectLeads({ provider, requests: store, uow: store, logger }, opts());
    expect(first.created).toBe(3);
    expect(store.leads.size).toBe(3);

    const second = await collectLeads({ provider, requests: store, uow: store, logger }, opts());
    expect(second.refreshed).toBe(3);
    expect(second.created).toBe(0);
    expect(store.leads.size).toBe(3); // no duplicates on rerun
  });

  it('stops at the lead cap', async () => {
    const store = new InMemoryCollectionStore();
    const provider = new MockLeadSource([business('a'), business('b'), business('c'), business('d')]);
    const summary = await collectLeads(
      { provider, requests: store, uow: store, logger },
      opts({ caps: { maxLeads: 2, pageSize: 20, maxPages: 5 } }),
    );
    expect(summary.created).toBe(2);
    expect(summary.stoppedAtCap).toBe(true);
    expect(store.leads.size).toBe(2);
  });

  it('flags ambiguous same-name/same-city records without merging', async () => {
    const store = new InMemoryCollectionStore();
    // Same name + city, no domain/phone/address to corroborate => ambiguous.
    const a = business('a', {
      businessName: 'Central Dental',
      domain: null,
      phone: null,
      formattedAddress: null,
      latitude: null,
      longitude: null,
    });
    const b = business('b', {
      businessName: 'Central Dental',
      domain: null,
      phone: null,
      formattedAddress: null,
      latitude: null,
      longitude: null,
    });
    const summary = await collectLeads(
      { provider: new MockLeadSource([a, b]), requests: store, uow: store, logger },
      opts(),
    );
    expect(summary.created).toBe(1);
    expect(summary.ambiguous).toBe(1);
    const ambiguous = [...store.leads.values()].find((l) => l.dedupStatus === 'AMBIGUOUS');
    expect(ambiguous?.duplicateOf).toBeTruthy();
    expect(store.leads.size).toBe(2); // flagged, NOT merged
  });

  it('handles interrupted pagination and reruns idempotently from page 1', async () => {
    const store = new InMemoryCollectionStore();
    // Provider yields one good page then throws on the second.
    const flaky: LeadSourceProvider = {
      name: 'mock',
       
      async *pages(_q: CollectQuery, _c: ProviderCaps): AsyncGenerator<ProviderPage> {
        yield {
          candidates: [{ sourcePlaceId: 'a', facts: business('a') }],
          request: {
            fieldMask: 'mock',
            pageIndex: 0,
            query: {},
            resultCount: 1,
            billedTier: null,
            estimatedCostUsd: 0,
            status: 'OK',
            startedAt: new Date(),
            completedAt: new Date(),
          },
        };
        throw new Error('network drop mid-pagination');
      },
    };

    const interrupted = await collectLeads({ provider: flaky, requests: store, uow: store, logger }, opts());
    expect(interrupted.interrupted).toBe(true);
    expect(interrupted.created).toBe(1); // page 1 persisted
    expect(store.leads.size).toBe(1);

    // Rerun from page 1 with a healthy provider: no duplicate for 'a'.
    const healthy = new MockLeadSource([business('a'), business('b')]);
    const rerun = await collectLeads({ provider: healthy, requests: store, uow: store, logger }, opts());
    expect(rerun.refreshed).toBe(1); // 'a' already known
    expect(rerun.created).toBe(1); // 'b' new
    expect(store.leads.size).toBe(2);
  });

  it('creates Place-ID-only candidates for id-only providers (no facts stored)', async () => {
    const store = new InMemoryCollectionStore();
    const idOnly: LeadSourceProvider = {
      name: 'google_places',
       
      async *pages(): AsyncGenerator<ProviderPage> {
        yield {
          candidates: [
            { sourcePlaceId: 'place-1', facts: null },
            { sourcePlaceId: 'place-2', facts: null },
          ],
          request: {
            fieldMask: 'places.id,nextPageToken',
            pageIndex: 0,
            query: {},
            resultCount: 2,
            billedTier: 'Essentials',
            estimatedCostUsd: 0.005,
            status: 'OK',
            startedAt: new Date(),
            completedAt: new Date(),
          },
        };
      },
    };
    const summary = await collectLeads(
      { provider: idOnly, requests: store, uow: store, logger },
      opts({ factsSource: 'manual' }),
    );
    expect(summary.created).toBe(2);
    for (const lead of store.leads.values()) {
      expect(lead.placeId).toMatch(/^place-/);
      expect(lead.businessName).toBeNull();
      expect(lead.normalizedDomain).toBeNull();
      expect(lead.phone).toBeNull();
      expect(lead.latitude).toBeNull();
      expect(lead.factsSource).toBeNull();
    }
  });
});
