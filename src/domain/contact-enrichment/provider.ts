import { type CandidatePerson, type DomainSearchResult, type EnrichmentEstimate, type EnrichmentQuery, type PreviewResult, type ProviderEnrichmentOutcome } from './types.js';

/**
 * Provider abstraction for decision-maker work-email discovery. Every concrete provider (Instantly,
 * Hunter as fallback #2; Apollo later) implements exactly this. The domain service depends on this
 * interface only — swapping providers never touches orchestration, caps, matching, or persistence.
 */
export interface ContactEnrichmentProvider {
  /** Stable provider name persisted for provenance, e.g. "instantly", "hunter", "mock". */
  readonly name: string;

  /**
   * NON-ENRICHING preview/search over a company domain. Returns the people the provider knows at that
   * domain (name/title/domain only — NO email, NO enrichment). MUST NOT reveal/verify an email and
   * MUST NOT spend a credit. This is the cheap coverage/identity step run BEFORE any paid enrichment.
   *
   * `candidates` is provided for providers (e.g. Hunter) whose primary lookup is per-person rather than
   * domain-wide: such a provider has no free domain-wide search step, so its preview MUST be a
   * zero-network echo of the already-known candidates rather than a real API call (a genuine per-person
   * lookup against Hunter's Email Finder is never free-on-success, so calling it here would violate the
   * no-credit/no-email-reveal contract). A domain-wide provider (Instantly) ignores this parameter.
   */
  preview(domain: string, candidates?: CandidatePerson[]): Promise<PreviewResult>;

  /**
   * Pre-spend availability estimate for one known person (plan/dry-run). MUST NOT charge or enrich.
   */
  estimate(query: EnrichmentQuery): Promise<EnrichmentEstimate>;

  /**
   * PAID work-email enrichment for ONE known person at ONE domain (spends a credit). Returns a
   * normalized outcome (which may be non-verified/not-found — the accept/reject decision is the
   * service's, not the provider's). Implementations Zod-validate the response and never log the key,
   * and MUST fail closed if their paid kill-switch is off.
   */
  enrich(query: EnrichmentQuery): Promise<ProviderEnrichmentOutcome>;

  /**
   * OPTIONAL final domain-wide fallback (e.g. Hunter Domain Search) for a provider whose ordinary
   * per-candidate enrich() loop found nothing. Called by the service AT MOST ONCE per run — only after
   * every matched candidate has been tried via enrich() and none was accepted, with no error/cap hit.
   * Returns raw, NOT-yet-accepted people with email; the service matches them against the known
   * candidates and runs each through the SAME decideAcceptance trust boundary as every other path (the
   * provider never decides acceptance itself). A provider without this capability simply omits it.
   */
  domainSearch?(domain: string): Promise<DomainSearchResult>;
}

/** Thrown by a paid provider constructed while its paid kill-switch/credentials are missing. */
export class EnrichmentProviderNotAllowedError extends Error {
  readonly code = 'ENRICHMENT_PROVIDER_NOT_ALLOWED';
  constructor(message: string) {
    super(message);
    this.name = 'EnrichmentProviderNotAllowedError';
  }
}
