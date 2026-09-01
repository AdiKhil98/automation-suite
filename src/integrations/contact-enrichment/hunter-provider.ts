import { createHash } from 'node:crypto';
import { type Logger } from 'pino';
import { AppError } from '../../utils/errors.js';
import { type ContactEnrichmentProvider, EnrichmentProviderNotAllowedError } from '../../domain/contact-enrichment/provider.js';
import {
  type CandidatePerson,
  type EnrichmentEstimate,
  type EnrichmentQuery,
  type PreviewPerson,
  type PreviewResult,
  type ProviderEnrichmentOutcome,
} from '../../domain/contact-enrichment/types.js';
import {
  HUNTER_ENDPOINTS,
  buildEmailFinderParams,
  buildEmailVerifierParams,
  extractFinderResult,
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
 * happens in enrich(): Email Finder for one known person, then an INDEPENDENT Email Verifier call on
 * whatever email Finder returned, before anything is accepted.
 *
 * Isolated HTTP surface: Bearer auth (key only in the header, never a query param, never logged),
 * per-request timeout, NO auto-retry, no polling (both calls are synchronous). Every response is
 * Zod-validated. Credits are never fabricated — Hunter's responses carry no credit-count field, so
 * creditsReported is always null; the service's own per-attempt estimate is the only spend tracking.
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
      // Free per Hunter's docs (no credit charged when no email is found) — no verifier call needed.
      return {
        query, email: null, returnedIdentity: null, verificationStatus: 'NOT_FOUND',
        dataQuality: null, confidence: null, creditsReported: null, resourceId: null,
        endpoint: HUNTER_ENDPOINTS.emailFinder, rawDigest: sha256(finderText),
      };
    }

    // Independent verification — never accept a Finder guess on its own.
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
      confidence: verifierFields.score !== null ? verifierFields.score / 100 : (finder.finderScore !== null ? finder.finderScore / 100 : null),
      creditsReported: null,
      resourceId: null,
      endpoint: HUNTER_ENDPOINTS.emailVerifier,
      rawDigest: sha256(`${finderText}|${verifierText}`),
    };
  }
}
