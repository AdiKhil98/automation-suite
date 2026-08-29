import { type EnrichmentEstimate, type EnrichmentQuery, type ProviderEnrichmentOutcome } from './types.js';

/**
 * Provider abstraction for decision-maker work-email enrichment. Every concrete provider
 * (Instantly now; Hunter/Apollo later) implements exactly this. The domain service depends on
 * this interface only — swapping providers never touches orchestration, caps, or persistence.
 */
export interface ContactEnrichmentProvider {
  /** Stable provider name persisted for provenance, e.g. "instantly", "mock". */
  readonly name: string;

  /**
   * Pre-spend availability check for one known person. MUST NOT charge credits or create a
   * durable enrichment. Used by plan/dry-run mode. Providers without an estimate endpoint return
   * `available: true, projectedCredits: <per-lookup cost>` so the plan still shows the cap math.
   */
  estimate(query: EnrichmentQuery): Promise<EnrichmentEstimate>;

  /**
   * Paid lookup for ONE known person at ONE domain. Returns a normalized outcome (which may be a
   * non-verified or not-found result — the accept/reject decision is the service's, not the
   * provider's). Implementations validate the raw response with Zod and never log the API key.
   */
  enrich(query: EnrichmentQuery): Promise<ProviderEnrichmentOutcome>;
}

/** Thrown by a paid provider constructed while its paid kill-switch/credentials are missing. */
export class EnrichmentProviderNotAllowedError extends Error {
  readonly code = 'ENRICHMENT_PROVIDER_NOT_ALLOWED';
  constructor(message: string) {
    super(message);
    this.name = 'EnrichmentProviderNotAllowedError';
  }
}
