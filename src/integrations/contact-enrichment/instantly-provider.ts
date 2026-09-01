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
  INSTANTLY_ENDPOINTS,
  buildEnrichLeadsRequestBody,
  buildLeadsListRequestBody,
  buildPreviewLeadsFromSupersearchRequestBody,
  enrichResponseSchema,
  extractLead,
  extractPreviewPerson,
  leadsFrom,
  leadsListResponseSchema,
  pollResponseSchema,
  previewLeadsResponseSchema,
} from './instantly-schema.js';

export type FetchLike = typeof fetch;

export interface InstantlyProviderDeps {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  pollMaxAttempts: number;
  pollIntervalMs: number;
  previewLimit: number;
  /** Whether the PAID enrich() step may run. Preview() is always allowed (non-enriching). */
  allowPaidEnrichment: boolean;
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
 * Instantly API v2 SuperSearch provider. Two operations, two DISTINCT endpoints — never mixed:
 *  - preview(domain): the dedicated, synchronous, NON-ENRICHING preview-leads-from-supersearch
 *    endpoint -> people at the domain, no email revealed, no enrichment credit, no job/poll. Domain-
 *    first query (no title filter); identity + title matching happens locally.
 *  - enrich(query): the async enrich-leads-from-supersearch job (create -> poll -> leads/list), PAID
 *    work-email enrichment for one known person (gated by allowPaidEnrichment).
 *
 * Isolated HTTP surface: Bearer auth (key only in the header, never logged), per-request timeout, NO
 * auto-retry, bounded polling (enrich only). Every response is Zod-validated; a returned enriched lead
 * lacking an email/verification field throws a schema mismatch instead of guessing. Credits are
 * PROVIDER-REPORTED (null when the provider reports none) — never silently defaulted. Network I/O only
 * via injected fetch.
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
        headers: { Authorization: `Bearer ${this.deps.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new AppError(`INSTANTLY_HTTP_${String(res.status)}`, `Instantly ${method} ${path} failed (${String(res.status)}).`);
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Create an async SuperSearch resource from a request body and poll it to completion. */
  private async createAndPoll(body: Record<string, unknown>): Promise<{ resourceId: string; credits: number | null }> {
    const created = enrichResponseSchema.parse(JSON.parse(await this.request('POST', INSTANTLY_ENDPOINTS.enrich, body)));
    const resourceId = created.resource_id ?? created.id ?? null;
    if (!resourceId) throw new AppError('INSTANTLY_NO_RESOURCE_ID', 'Instantly enrich-leads-from-supersearch returned no resource_id.');
    let credits: number | null = readCredits(created);
    for (let attempt = 0; attempt < this.deps.pollMaxAttempts; attempt += 1) {
      const parsed = pollResponseSchema.parse(JSON.parse(await this.request('GET', INSTANTLY_ENDPOINTS.getEnrichment(resourceId))));
      credits = readCredits(parsed) ?? credits;
      if (parsed.in_progress !== true) break;
      if (attempt < this.deps.pollMaxAttempts - 1) await this.sleep(this.deps.pollIntervalMs);
    }
    return { resourceId, credits };
  }

  async preview(domain: string): Promise<PreviewResult> {
    const text = await this.request('POST', INSTANTLY_ENDPOINTS.previewLeads, buildPreviewLeadsFromSupersearchRequestBody(domain, this.deps.previewLimit));
    const parsed = previewLeadsResponseSchema.parse(JSON.parse(text));
    const people: PreviewPerson[] = (parsed.leads ?? []).map((row) => extractPreviewPerson(row));
    return {
      domain,
      people,
      // No credits field in this response shape — null unless the provider explicitly reports one.
      creditsReported: readCredits(parsed),
      resourceId: null,
      endpoint: INSTANTLY_ENDPOINTS.previewLeads,
      rawDigest: sha256(text),
    };
  }

  estimate(query: EnrichmentQuery): Promise<EnrichmentEstimate> {
    return Promise.resolve({ query, available: true, projectedCredits: 1, endpoint: INSTANTLY_ENDPOINTS.enrich });
  }

  async enrich(query: EnrichmentQuery): Promise<ProviderEnrichmentOutcome> {
    // Paid kill switch: enrichment spends a credit and must fail closed when disabled. Preview does not.
    if (!this.deps.allowPaidEnrichment) {
      throw new EnrichmentProviderNotAllowedError('Instantly enrichment requires ALLOW_PAID_ENRICHMENT_CALLS=true (paid enrichment is off).');
    }
    const { resourceId, credits: pollCredits } = await this.createAndPoll(buildEnrichLeadsRequestBody(query));
    const listText = await this.request('POST', INSTANTLY_ENDPOINTS.leadsList, buildLeadsListRequestBody(resourceId));
    const listParsed = leadsListResponseSchema.parse(JSON.parse(listText));
    const creditsReported = readCredits(listParsed) ?? pollCredits;
    const rows = leadsFrom(listParsed);

    if (rows.length === 0) {
      return {
        query, email: null, returnedIdentity: null, verificationStatus: 'NOT_FOUND',
        dataQuality: null, confidence: null, creditsReported, resourceId, endpoint: INSTANTLY_ENDPOINTS.enrich, rawDigest: sha256(listText),
      };
    }
    // extractLead THROWS on a lead missing email/verification -> the run stops (never guesses).
    const lead = extractLead(rows[0] as Record<string, unknown>);
    return {
      query, email: lead.email, returnedIdentity: lead.identity, verificationStatus: lead.verification,
      dataQuality: lead.dataQuality, confidence: lead.confidence, creditsReported, resourceId, endpoint: INSTANTLY_ENDPOINTS.enrich, rawDigest: sha256(listText),
    };
  }
}
