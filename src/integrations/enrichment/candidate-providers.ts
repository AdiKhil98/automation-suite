import { type Candidate, type EnrichmentContext } from '../../domain/enrichment/types.js';
import { type DiscoverySource } from '../../domain/enrichment/outcome.js';
import {
  type CandidateProvider,
  type LeadEnrichmentInput,
  type ProviderCapabilities,
} from './provider.js';

function dedupe(pairs: Array<[string, DiscoverySource]>): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const [url, source] of pairs) {
    const key = url.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ url: key, discoverySource: source });
  }
  return out;
}

/** Production-usable: candidate URLs from operator input and context hints. No cost, no Google. */
export class ManualCandidateProvider implements CandidateProvider {
  readonly name = 'manual';
  readonly capabilities: ProviderCapabilities = {
    returnsFields: ['url'],
    persistableFields: ['url'],
    ephemeralFields: [],
    canIncurCost: false,
  };
  async candidatesFor(input: LeadEnrichmentInput, context: EnrichmentContext): Promise<Candidate[]> {
    return dedupe([
      ...(input.manual?.candidateUrls ?? []).map((u): [string, DiscoverySource] => [u, 'manual']),
      ...(context.candidateUrls ?? []).map((u): [string, DiscoverySource] => [u, 'website_hint']),
    ]);
  }
}

/** Fixture-backed candidates for tests. */
export class MockCandidateProvider implements CandidateProvider {
  readonly name = 'mock';
  readonly capabilities: ProviderCapabilities = {
    returnsFields: ['url'],
    persistableFields: ['url'],
    ephemeralFields: [],
    canIncurCost: false,
  };
  constructor(private readonly byKey: Map<string, string[]>) {}
  async candidatesFor(input: LeadEnrichmentInput, context: EnrichmentContext): Promise<Candidate[]> {
    const fixture = this.byKey.get(input.placeId ?? input.leadId) ?? [];
    return dedupe([
      ...fixture.map((u): [string, DiscoverySource] => [u, 'mock']),
      ...(context.candidateUrls ?? []).map((u): [string, DiscoverySource] => [u, 'website_hint']),
    ]);
  }
}
