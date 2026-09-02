import { createHash } from 'node:crypto';
import { type Logger } from 'pino';
import { AppError } from '../../utils/errors.js';
import { type ContactEnrichmentProvider, EnrichmentProviderNotAllowedError } from '../../domain/contact-enrichment/provider.js';
import {
  type EnrichmentEstimate,
  type EnrichmentQuery,
  type PreviewPerson,
  type PreviewResult,
  type ProviderEnrichmentOutcome,
} from '../../domain/contact-enrichment/types.js';
import {
  APOLLO_ENDPOINTS,
  apolloPeopleSearchResponseSchema,
  apolloPersonMatchResponseSchema,
  buildPeopleMatchRequestBody,
  buildPeopleSearchRequestBody,
  extractApolloPerson,
  extractApolloPreviewPerson,
  peopleFrom,
  readApolloCredits,
} from './apollo-schema.js';

export type FetchLike = typeof fetch;

export interface ApolloProviderDeps {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  previewLimit: number;
  /** Whether the PAID People Match enrich() step may run. preview() is always allowed (0 credits). */
  allowPaidEnrichment: boolean;
  logger: Logger;
  /** Injected for tests — a fake transport keeps the standard suite at zero paid/network calls. */
  fetchImpl?: FetchLike;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * Apollo API v1 provider — fallback #3, tried only after Instantly and Hunter have been tried/exhausted
 * for a given lead. Two operations, two distinct endpoints:
 *  - preview(domain): free, synchronous People Search over the domain — 0 credits, no email revealed,
 *    NEVER gated by allowPaidEnrichment (mirrors Instantly's preview). Domain-scoped only, no
 *    server-side title filter — local matchPreviewPerson does all identity/title matching, so an
 *    Apollo-side title filter can never destroy recall for a slightly-differently-worded title.
 *  - enrich(query): paid People Match for ONE known person (gated by allowPaidEnrichment). Prefers
 *    the Apollo person id carried by the matched preview row; falls back to verified name + domain.
 *
 * Isolated HTTP surface: `X-Api-Key` header auth (key only in the header, never a query param, never
 * logged), per-request timeout, NO auto-retry, no polling (both calls are synchronous). Every response
 * is Zod-validated. Credits are read defensively from the response and never fabricated — creditsUsed
 * (the internal cap-math estimate) stays at its default of 1 per Match attempt regardless of hit/miss,
 * since there is no documented proof Apollo's Match is free on a miss (conservative/fail-closed-on-spend).
 */
export class ApolloContactEnrichmentProvider implements ContactEnrichmentProvider {
  readonly name = 'apollo';
  private readonly fetchImpl: FetchLike;

  constructor(private readonly deps: ApolloProviderDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  private async request(path: string, body: unknown): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, this.deps.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.deps.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'X-Api-Key': this.deps.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new AppError(`APOLLO_HTTP_${String(res.status)}`, `Apollo POST ${path} failed (${String(res.status)}).`);
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  async preview(domain: string): Promise<PreviewResult> {
    const text = await this.request(APOLLO_ENDPOINTS.peopleSearch, buildPeopleSearchRequestBody(domain, this.deps.previewLimit));
    const parsed = apolloPeopleSearchResponseSchema.parse(JSON.parse(text));
    const people: PreviewPerson[] = peopleFrom(parsed).map(extractApolloPreviewPerson);
    return {
      domain,
      people,
      creditsReported: readApolloCredits(parsed),
      resourceId: null,
      endpoint: APOLLO_ENDPOINTS.peopleSearch,
      rawDigest: sha256(text),
    };
  }

  estimate(query: EnrichmentQuery): Promise<EnrichmentEstimate> {
    return Promise.resolve({ query, available: true, projectedCredits: 1, endpoint: APOLLO_ENDPOINTS.peopleMatch });
  }

  async enrich(query: EnrichmentQuery): Promise<ProviderEnrichmentOutcome> {
    if (!this.deps.allowPaidEnrichment) {
      throw new EnrichmentProviderNotAllowedError('Apollo enrichment requires ALLOW_PAID_ENRICHMENT_CALLS=true (paid enrichment is off).');
    }
    const text = await this.request(APOLLO_ENDPOINTS.peopleMatch, buildPeopleMatchRequestBody(query));
    const parsed = apolloPersonMatchResponseSchema.parse(JSON.parse(text));
    const creditsReported = readApolloCredits(parsed);
    const person = extractApolloPerson(parsed);

    if (!person) {
      return {
        query, email: null, returnedIdentity: null, verificationStatus: 'NOT_FOUND',
        dataQuality: null, confidence: null, creditsReported, resourceId: null,
        endpoint: APOLLO_ENDPOINTS.peopleMatch, rawDigest: sha256(text),
      };
    }
    return {
      query, email: person.email, returnedIdentity: person.identity, verificationStatus: person.verificationStatus,
      dataQuality: person.dataQuality, confidence: person.confidence, creditsReported, resourceId: person.apolloId,
      endpoint: APOLLO_ENDPOINTS.peopleMatch, rawDigest: sha256(text),
    };
  }
}
