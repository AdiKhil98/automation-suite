import { createHash } from 'node:crypto';
import { type ContactEnrichmentProvider } from '../../domain/contact-enrichment/provider.js';
import {
  type EnrichmentEstimate,
  type EnrichmentQuery,
  type ProviderEnrichmentOutcome,
} from '../../domain/contact-enrichment/types.js';

export type MockEnrichmentResponder = (query: EnrichmentQuery) => ProviderEnrichmentOutcome;

/**
 * Default responder: finds nothing. The mock NEVER fabricates a verified address on its own, so a
 * CLI run with the (default) mock provider fails closed rather than inventing data. Tests inject a
 * responder to exercise verified / risky / generic / not-found paths deterministically.
 */
export const notFoundResponder: MockEnrichmentResponder = (query) => ({
  query,
  email: null,
  returnedIdentity: null,
  verificationStatus: 'NOT_FOUND',
  dataQuality: null,
  confidence: null,
  creditsUsed: 0,
  resourceId: null,
  endpoint: 'mock://contact-enrichment',
  rawDigest: createHash('sha256').update(`mock:${query.domain}:${query.fullName}`).digest('hex'),
});

/** In-memory, deterministic provider double. Zero network, zero credits. */
export class MockContactEnrichmentProvider implements ContactEnrichmentProvider {
  readonly name = 'mock';
  constructor(private readonly responder: MockEnrichmentResponder = notFoundResponder) {}

  estimate(query: EnrichmentQuery): Promise<EnrichmentEstimate> {
    return Promise.resolve({ query, available: false, projectedCredits: 0, endpoint: 'mock://contact-enrichment/estimate' });
  }

  enrich(query: EnrichmentQuery): Promise<ProviderEnrichmentOutcome> {
    return Promise.resolve(this.responder(query));
  }
}
