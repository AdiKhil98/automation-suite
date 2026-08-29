import { createHash } from 'node:crypto';
import { type Logger } from 'pino';
import { AppError } from '../../utils/errors.js';
import { type ContactEnrichmentProvider } from '../../domain/contact-enrichment/provider.js';
import {
  type EnrichmentEstimate,
  type EnrichmentQuery,
  type ProviderEnrichmentOutcome,
} from '../../domain/contact-enrichment/types.js';
import {
  INSTANTLY_ENDPOINTS,
  buildEnrichLeadsRequestBody,
  buildLeadsListRequestBody,
  enrichResponseSchema,
  extractLead,
  leadsFrom,
  leadsListResponseSchema,
  pollResponseSchema,
} from './instantly-schema.js';

export type FetchLike = typeof fetch;

export interface InstantlyProviderDeps {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  pollMaxAttempts: number;
  pollIntervalMs: number;
  logger: Logger;
  /** Injected for tests — a fake transport keeps the standard suite at zero paid/network calls. */
  fetchImpl?: FetchLike;
  /** Injected so tests skip real waits between polls. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const readCredits = (o: Record<string, unknown>): number | null => {
  const cu = o['credits_used'];
  const c = o['credits'];
  return typeof cu === 'number' ? cu : typeof c === 'number' ? c : null;
};

/**
 * Instantly API v2 SuperSearch enrichment provider (3-step: enrich -> poll -> leads/list). Isolated
 * HTTP surface: Bearer auth (the key is only ever placed in the Authorization header, never logged),
 * per-request AbortController timeout, NO SDK/auto-retry, and bounded polling. Every response is
 * Zod-validated; a returned lead lacking an email/verification field throws a schema mismatch instead
 * of guessing. Network I/O flows only through the injected fetch, so tests run fully offline.
 */
export class InstantlyContactEnrichmentProvider implements ContactEnrichmentProvider {
  readonly name = 'instantly';
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: InstantlyProviderDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.sleep = deps.sleep ?? defaultSleep;
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, this.deps.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.deps.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.deps.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        // Never echo the response body verbatim (may carry PII); code + status only.
        throw new AppError(`INSTANTLY_HTTP_${String(res.status)}`, `Instantly ${method} ${path} failed (${String(res.status)}).`);
      }
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  estimate(query: EnrichmentQuery): Promise<EnrichmentEstimate> {
    // No documented pre-spend estimate endpoint; return a local projection (no network, no spend).
    return Promise.resolve({ query, available: true, projectedCredits: 1, endpoint: INSTANTLY_ENDPOINTS.enrich });
  }

  async enrich(query: EnrichmentQuery): Promise<ProviderEnrichmentOutcome> {
    // 1) Run the SuperSearch + work-email enrichment; get the generated list resource id.
    const created = enrichResponseSchema.parse(JSON.parse(await this.request('POST', INSTANTLY_ENDPOINTS.enrich, buildEnrichLeadsRequestBody(query))));
    const resourceId = created.resource_id ?? created.id ?? null;
    if (!resourceId) {
      throw new AppError('INSTANTLY_NO_RESOURCE_ID', 'Instantly enrich-leads-from-supersearch returned no resource_id.');
    }

    // 2) Poll the enrichment job until it finishes (bounded).
    let credits: number | null = null;
    for (let attempt = 0; attempt < this.deps.pollMaxAttempts; attempt += 1) {
      const parsed = pollResponseSchema.parse(JSON.parse(await this.request('GET', INSTANTLY_ENDPOINTS.getEnrichment(resourceId))));
      credits = readCredits(parsed) ?? credits;
      if (parsed.in_progress !== true) break;
      if (attempt < this.deps.pollMaxAttempts - 1) await this.sleep(this.deps.pollIntervalMs);
    }

    // 3) Retrieve the enriched contact from the generated list.
    const listText = await this.request('POST', INSTANTLY_ENDPOINTS.leadsList, buildLeadsListRequestBody(resourceId));
    const listParsed = leadsListResponseSchema.parse(JSON.parse(listText));
    credits = readCredits(listParsed) ?? credits;
    const rows = leadsFrom(listParsed);
    // A work-email enrichment consumes at least one credit even when reporting is absent.
    const creditsUsed = credits ?? 1;

    if (rows.length === 0) {
      return {
        query, email: null, returnedIdentity: null, verificationStatus: 'NOT_FOUND',
        dataQuality: null, confidence: null, creditsUsed, resourceId, endpoint: INSTANTLY_ENDPOINTS.enrich, rawDigest: sha256(listText),
      };
    }
    // extractLead THROWS on a lead missing email/verification -> the run stops (never guesses).
    const lead = extractLead(rows[0] as Record<string, unknown>);
    return {
      query,
      email: lead.email,
      returnedIdentity: lead.identity,
      verificationStatus: lead.verification,
      dataQuality: lead.dataQuality,
      confidence: lead.confidence,
      creditsUsed,
      resourceId,
      endpoint: INSTANTLY_ENDPOINTS.enrich,
      rawDigest: sha256(listText),
    };
  }
}
