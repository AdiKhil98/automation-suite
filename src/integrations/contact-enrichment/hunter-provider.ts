import { createHash } from 'node:crypto';
import { type Logger } from 'pino';
import { AppError } from '../../utils/errors.js';
import { type ContactEnrichmentProvider, EnrichmentProviderNotAllowedError } from '../../domain/contact-enrichment/provider.js';
import {
  type CandidatePerson,
  type DomainSearchResult,
  type EnrichmentEstimate,
  type EnrichmentQuery,
  type PreviewPerson,
  type PreviewResult,
  type ProviderEnrichmentOutcome,
} from '../../domain/contact-enrichment/types.js';
import {
  HUNTER_ENDPOINTS,
  buildDomainSearchParams,
  buildEmailFinderParams,
  buildEmailVerifierParams,
  classifyFinderVerification,
  estimateDomainSearchCredits,
  extractDomainSearchPeople,
  extractFinderResult,
  hunterDomainSearchResponseSchema,
  hunterFinderResponseSchema,
  hunterVerifierResponseSchema,
  normalizeHunterVerification,
  readVerifierFields,
} from './hunter-schema.js';

export type FetchLike = typeof fetch;

export interface HunterProviderDeps {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  /** Whether the PAID Finder+Verifier enrich() step may run. */
  allowPaidEnrichment: boolean;
  logger: Logger;
  /** Injected for tests — a fake transport keeps the standard suite at zero paid/network calls. */
  fetchImpl?: FetchLike;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * Hunter API v2 provider — fallback #2, tried only after Instantly preview/enrich have been tried.
 * Hunter has no free domain-wide search step in this integration, so preview() is a zero-network echo
 * of the already-known candidates (see ContactEnrichmentProvider.preview doc). All real network I/O
 * happens in enrich(): Email Finder for one known person first. Finder's OWN bundled verification
 * (already included in the Finder credit) is trusted directly when it is unambiguous — VERIFIED when
 * clearly valid, CATCH_ALL when clearly accept-all — and only a genuinely ambiguous/stale Finder
 * verification (its `unknown` status, or a missing verification object) triggers a SEPARATE Email
 * Verifier call for a fresh determination. Verifier is never called automatically after every
 * successful Finder match — only when Finder's own signal isn't trustworthy on its own.
 *
 * Isolated HTTP surface: Bearer auth (key only in the header, never a query param, never logged),
 * per-request timeout, NO auto-retry, no polling (both calls are synchronous). Every response is
 * Zod-validated. Credits are never fabricated — Hunter's responses carry no credit-count field, so
 * creditsReported is always null; `requestsUsed`/`creditsUsed` report the ACTUAL number of HTTP calls
 * this one enrich() performed (1 for Finder alone, 2 when Verifier was also genuinely needed), so the
 * service's request/credit caps reflect real operations rather than assuming one call per attempt.
 */
export class HunterContactEnrichmentProvider implements ContactEnrichmentProvider {
  readonly name = 'hunter';
  private readonly fetchImpl: FetchLike;

  constructor(private readonly deps: HunterProviderDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  private async request(path: string, params: URLSearchParams): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, this.deps.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.deps.baseUrl}${path}?${params.toString()}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.deps.apiKey}`, Accept: 'application/json' },
        signal: controller.signal,
      });
      const text = await res.text();
      // Never include the query string (it never carries the key here, but keep the error surface minimal regardless).
      if (!res.ok) throw new AppError(`HUNTER_HTTP_${String(res.status)}`, `Hunter GET ${path} failed (${String(res.status)}).`);
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Zero-network echo of the already-known candidates. Hunter's primary lookup (Finder) is per-person
   * and never free-on-success, so it cannot serve as this provider's non-enriching preview step; the
   * candidates were already sourced independently (the official website), so there is nothing further
   * to confirm before the paid Finder+Verifier attempt in enrich().
   */
  preview(domain: string, candidates: CandidatePerson[] = []): Promise<PreviewResult> {
    const people: PreviewPerson[] = candidates.map((c) => ({
      name: c.fullName, firstName: c.firstName, lastName: c.lastName, domain, title: c.title, providerLeadId: null,
    }));
    return Promise.resolve({
      domain,
      people,
      creditsReported: null,
      resourceId: null,
      endpoint: 'hunter:local-candidate-echo (no network call)',
      rawDigest: sha256(`hunter-preview-echo:${domain}:${candidates.map((c) => c.fullName).join('|')}`),
    });
  }

  estimate(query: EnrichmentQuery): Promise<EnrichmentEstimate> {
    return Promise.resolve({ query, available: true, projectedCredits: 1, endpoint: HUNTER_ENDPOINTS.emailFinder });
  }

  async enrich(query: EnrichmentQuery): Promise<ProviderEnrichmentOutcome> {
    if (!this.deps.allowPaidEnrichment) {
      throw new EnrichmentProviderNotAllowedError('Hunter enrichment requires ALLOW_PAID_ENRICHMENT_CALLS=true (paid enrichment is off).');
    }

    const finderText = await this.request(HUNTER_ENDPOINTS.emailFinder, buildEmailFinderParams(query));
    const finderParsed = hunterFinderResponseSchema.parse(JSON.parse(finderText));
    const finder = extractFinderResult(finderParsed);

    if (!finder.email) {
      // Free per Hunter's docs (no credit charged when no email is found) — one HTTP call, zero credits.
      return {
        query, email: null, returnedIdentity: null, verificationStatus: 'NOT_FOUND',
        dataQuality: null, confidence: null, creditsReported: null, resourceId: null,
        endpoint: HUNTER_ENDPOINTS.emailFinder, rawDigest: sha256(finderText),
        requestsUsed: 1, creditsUsed: 0,
      };
    }

    // Finder found an email — that credit is already spent regardless of what happens next.
    const finderConfidence = finder.finderScore !== null ? finder.finderScore / 100 : null;
    const decision = classifyFinderVerification(finder);

    if (decision.kind !== 'ambiguous') {
      // Finder's own bundled verification is unambiguous (valid, or clearly accept-all) — trust it
      // directly rather than spending a second Verifier credit to confirm what is already clear.
      return {
        query, email: finder.email, returnedIdentity: finder.identity, verificationStatus: decision.status,
        dataQuality: null, confidence: finderConfidence, creditsReported: null, resourceId: null,
        endpoint: HUNTER_ENDPOINTS.emailFinder, rawDigest: sha256(finderText),
        requestsUsed: 1, creditsUsed: 1,
      };
    }

    // Finder's verification is genuinely ambiguous/stale (unknown or missing) — a fresh, independent
    // Verifier call is needed before this email can ever be accepted.
    const verifierText = await this.request(HUNTER_ENDPOINTS.emailVerifier, buildEmailVerifierParams(finder.email));
    const verifierParsed = hunterVerifierResponseSchema.parse(JSON.parse(verifierText));
    const verifierFields = readVerifierFields(verifierParsed);
    const verificationStatus = normalizeHunterVerification(verifierFields);

    return {
      query,
      email: finder.email,
      returnedIdentity: finder.identity,
      verificationStatus,
      dataQuality: null,
      confidence: verifierFields.score !== null ? verifierFields.score / 100 : finderConfidence,
      creditsReported: null,
      resourceId: null,
      endpoint: HUNTER_ENDPOINTS.emailVerifier,
      rawDigest: sha256(`${finderText}|${verifierText}`),
      requestsUsed: 2,
      creditsUsed: 2,
    };
  }

  /**
   * FINAL Hunter fallback: a single domain-wide Domain Search call, used by the service AT MOST ONCE
   * per run, only after every per-candidate Finder attempt has failed. Returns raw people with email
   * (already verification-normalized — see classifyDomainSearchEmail) for the service to match against
   * the known candidates through the same decideAcceptance trust boundary as everything else.
   */
  async domainSearch(domain: string): Promise<DomainSearchResult> {
    if (!this.deps.allowPaidEnrichment) {
      throw new EnrichmentProviderNotAllowedError('Hunter Domain Search requires ALLOW_PAID_ENRICHMENT_CALLS=true (paid enrichment is off).');
    }
    const text = await this.request(HUNTER_ENDPOINTS.domainSearch, buildDomainSearchParams(domain));
    const parsed = hunterDomainSearchResponseSchema.parse(JSON.parse(text));
    const people = extractDomainSearchPeople(parsed, domain);
    return {
      domain,
      people,
      creditsReported: null,
      // Hunter's pricing model: roughly 1 search credit per 1–10 emails returned, 0 on an empty result.
      creditsUsed: estimateDomainSearchCredits(people.length),
      endpoint: HUNTER_ENDPOINTS.domainSearch,
      rawDigest: sha256(text),
    };
  }
}
