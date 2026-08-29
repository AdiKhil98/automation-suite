import { createHash } from 'node:crypto';
import { type ContactEnrichmentProvider } from '../../domain/contact-enrichment/provider.js';
import {
  type EnrichmentEstimate,
  type EnrichmentQuery,
  type PreviewResult,
  type ProviderEnrichmentOutcome,
} from '../../domain/contact-enrichment/types.js';

export type MockEnrichmentResponder = (query: EnrichmentQuery) => ProviderEnrichmentOutcome;
export type MockPreviewResponder = (domain: string) => PreviewResult;

/**
 * Default enrich responder: finds nothing. The mock NEVER fabricates a verified address on its own, so
 * a CLI run with the (default) mock provider fails closed rather than inventing data. Tests inject
 * responders to exercise verified / risky / generic / not-found / preview paths deterministically.
 */
export const notFoundResponder: MockEnrichmentResponder = (query) => ({
  query,
  email: null,
  returnedIdentity: null,
  verificationStatus: 'NOT_FOUND',
  dataQuality: null,
  confidence: null,
  creditsReported: null,
  resourceId: null,
  endpoint: 'mock://contact-enrichment',
  rawDigest: createHash('sha256').update(`mock:${query.domain}:${query.fullName}`).digest('hex'),
});

/** Default preview: no people found at the domain. */
export const emptyPreviewResponder: MockPreviewResponder = (domain) => ({
  domain, people: [], creditsReported: null, resourceId: null, endpoint: 'mock://contact-enrichment/preview',
  rawDigest: createHash('sha256').update(`mock-preview:${domain}`).digest('hex'),
});

/** In-memory, deterministic provider double. Zero network, zero credits. */
export class MockContactEnrichmentProvider implements ContactEnrichmentProvider {
  readonly name = 'mock';
  constructor(
    private readonly responder: MockEnrichmentResponder = notFoundResponder,
    private readonly previewResponder: MockPreviewResponder = emptyPreviewResponder,
  ) {}

  preview(domain: string): Promise<PreviewResult> {
    return Promise.resolve(this.previewResponder(domain));
  }

  estimate(query: EnrichmentQuery): Promise<EnrichmentEstimate> {
    return Promise.resolve({ query, available: false, projectedCredits: 0, endpoint: 'mock://contact-enrichment/estimate' });
  }

  enrich(query: EnrichmentQuery): Promise<ProviderEnrichmentOutcome> {
    return Promise.resolve(this.responder(query));
  }
}
