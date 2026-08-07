import { EnrichmentService } from '../../domain/enrichment/enrichment-service.js';
import { AppError } from '../../utils/errors.js';
import {
  FactsContextProvider,
  type GoogleReadBudget,
  GoogleContextProvider,
  ManualContextProvider,
  MockContextProvider,
} from '../../integrations/enrichment/context-providers.js';
import {
  ManualCandidateProvider,
  MockCandidateProvider,
} from '../../integrations/enrichment/candidate-providers.js';
import { GooglePlacesDetailsClient, type PlacesDetailsClient } from '../../integrations/enrichment/google-places-details.js';
import { HttpWebsiteVerifier, SafeHttpPageFetcher } from '../../integrations/enrichment/http-website-verifier.js';
import { MockPageFetcher } from '../../integrations/enrichment/mock-page-fetcher.js';
import { type EnrichmentContextProvider, type CandidateProvider, type PageFetcher } from '../../integrations/enrichment/provider.js';
import { mockEnrichmentCandidates, mockEnrichmentPages } from '../../fixtures/mock-enrichment.js';
import { DrizzleEnrichmentUnitOfWork } from '../../persistence/enrichment-unit-of-work.js';
import { DrizzleGooglePlaceDetailsStore } from '../../persistence/google-place-details-store.js';
import { type VerifyOptions } from '../../domain/enrichment/verify-domain.js';
import { type CliContext } from '../context.js';

const NULL_PLACES_CLIENT: PlacesDetailsClient = { details: async () => null };

export interface BuiltEnrichment {
  service: EnrichmentService;
  verify: VerifyOptions;
  budget: GoogleReadBudget;
}

export interface BuildEnrichmentOptions {
  /** Manual `enrich-lead` path: operator-supplied candidate URLs, real HTTP fetch. */
  forceManual?: boolean;
  /** Campaign niche allowed categories — enables the places_website_identity_match fallback. */
  nicheAllowedCategories?: readonly string[];
}

/**
 * Assemble the enrichment service from configuration. `forceManual` is used by the
 * manual `enrich-lead` path (operator-supplied candidate URLs, real HTTP fetch).
 * `nicheAllowedCategories`, when provided by a campaign-scoped caller, enables the
 * deterministic places_website_identity_match fallback (otherwise it fails closed).
 */
export function buildEnrichmentService(ctx: CliContext, opts: BuildEnrichmentOptions = {}): BuiltEnrichment {
  const { forceManual = false, nicheAllowedCategories } = opts;
  const c = ctx.config;
  const factsProvider = new FactsContextProvider();

  const budget: GoogleReadBudget = {
    requests: 0,
    estimatedCostUsd: 0,
    maxRequests: c.MAX_GOOGLE_CONTEXT_REQUESTS_PER_RUN,
    maxCostUsd: c.MAX_GOOGLE_CONTEXT_COST_USD_PER_RUN,
  };

  let contextProvider: EnrichmentContextProvider = factsProvider;
  if (forceManual || c.ENRICHMENT_CONTEXT_PROVIDER === 'manual') {
    contextProvider = new ManualContextProvider();
  } else if (c.ENRICHMENT_CONTEXT_PROVIDER === 'mock') {
    contextProvider = new MockContextProvider(new Map());
  } else if (c.ENRICHMENT_CONTEXT_PROVIDER === 'google') {
    const client = c.GOOGLE_PLACES_API_KEY
      ? new GooglePlacesDetailsClient(c.GOOGLE_PLACES_API_KEY, c.ENRICH_HTTP_TIMEOUT_MS, ctx.logger)
      : NULL_PLACES_CLIENT;
    contextProvider = new GoogleContextProvider({
      client,
      allowPaidReads: c.ALLOW_PAID_READS,
      budget,
      logger: ctx.logger,
      detailsStore: new DrizzleGooglePlaceDetailsStore(ctx.db),
      persistApprovedPhone: false,
    });
  }

  const useMock = !forceManual && c.ENRICHMENT_CANDIDATE_PROVIDER === 'mock';
  let candidateProvider: CandidateProvider;
  if (forceManual || c.ENRICHMENT_CANDIDATE_PROVIDER === 'manual') {
    candidateProvider = new ManualCandidateProvider();
  } else if (c.ENRICHMENT_CANDIDATE_PROVIDER === 'mock') {
    candidateProvider = new MockCandidateProvider(mockEnrichmentCandidates);
  } else {
    throw new AppError('NOT_IMPLEMENTED', 'search candidate provider is not implemented yet');
  }

  const fetcher: PageFetcher = useMock
    ? new MockPageFetcher(mockEnrichmentPages)
    : new SafeHttpPageFetcher({
        timeoutMs: c.ENRICH_HTTP_TIMEOUT_MS,
        maxRedirects: c.ENRICH_MAX_REDIRECTS,
        maxBytes: c.ENRICH_MAX_BYTES,
      });

  const verify: VerifyOptions = {
    minConfidence: c.ENRICHMENT_MIN_CONFIDENCE,
    ambiguousMargin: c.ENRICHMENT_AMBIGUOUS_MARGIN,
    nicheAllowedCategories,
  };

  const service = new EnrichmentService({
    contextProvider,
    factsContextProvider: factsProvider,
    candidateProvider,
    verifier: new HttpWebsiteVerifier(fetcher, { ...verify, maxPages: c.ENRICH_MAX_PAGES }),
    uow: new DrizzleEnrichmentUnitOfWork(ctx.db),
    logger: ctx.logger,
  });

  return { service, verify, budget };
}
