import { z } from 'zod';
import { AppError } from '../../utils/errors.js';
import { type EnrichmentQuery, type EnrichmentVerificationStatus, type ReturnedIdentity } from '../../domain/contact-enrichment/types.js';

/**
 * Instantly API v2 — SuperSearch enrichment + leads retrieval contract (the ONLY external surface we
 * depend on). Verified against the current official docs:
 *
 *   1. POST /api/v2/supersearch-enrichment/enrich-leads-from-supersearch   -> { resource_id }
 *   2. GET  /api/v2/supersearch-enrichment/{resource_id}                    -> poll until in_progress=false
 *   3. POST /api/v2/leads/list   { list_id: resource_id }                   -> the enriched contact(s)
 *
 * Auth: `Authorization: Bearer <INSTANTLY_API_KEY>`, `Content-Type: application/json`.
 * Base URL: config INSTANTLY_API_BASE_URL (default https://api.instantly.ai/api/v2).
 *
 * Extraction is defensive: if a lead is returned that lacks a recognizable email or verification
 * field, we THROW a schema-mismatch (never guess), so the caller stops instead of consuming credits.
 */

export const INSTANTLY_ENDPOINTS = {
  /** Async: run a SuperSearch + work-email enrichment. Returns the generated list resource_id. */
  enrich: '/supersearch-enrichment/enrich-leads-from-supersearch',
  /** Poll the enrichment job by resource_id until in_progress=false. */
  getEnrichment: (resourceId: string): string => `/supersearch-enrichment/${encodeURIComponent(resourceId)}`,
  /** Retrieve the enriched contacts from the generated list. */
  leadsList: '/leads/list',
} as const;

/** Scopes the API key must carry. */
export const INSTANTLY_SCOPES = {
  enrich: 'supersearch_enrichments:all',
  read: 'supersearch_enrichments:read',
  leadsRead: 'leads:read',
} as const;

/**
 * Build the enrich-leads-from-supersearch request body for ONE known person at ONE company domain.
 * name + domains pin the person/company; title.include narrows where useful; work-email enrichment
 * with skip_rows_without_email keeps the result to a verifiable professional address.
 */
export function buildEnrichLeadsRequestBody(q: EnrichmentQuery): Record<string, unknown> {
  return {
    limit: 1,
    work_email_enrichment: true,
    skip_rows_without_email: true,
    search_filters: {
      name: [q.fullName],
      domains: [q.domain],
      ...(q.title ? { title: { include: [q.title] } } : {}),
    },
  };
}

/** Build the leads/list request body scoped to the generated enrichment list. */
export function buildLeadsListRequestBody(resourceId: string): Record<string, unknown> {
  return { list_id: resourceId, limit: 1 };
}

/** POST enrich response — the generated/list resource id. */
export const enrichResponseSchema = z
  .object({ resource_id: z.string().optional(), id: z.string().optional() })
  .passthrough();

/** GET poll response — job status. */
export const pollResponseSchema = z
  .object({ resource_id: z.string().optional(), id: z.string().optional(), in_progress: z.boolean().optional() })
  .passthrough();

/** POST leads/list response — tolerant of the array key (items | leads | data). */
export const leadsListResponseSchema = z
  .object({
    items: z.array(z.record(z.string(), z.unknown())).optional(),
    leads: z.array(z.record(z.string(), z.unknown())).optional(),
    data: z.array(z.record(z.string(), z.unknown())).optional(),
    credits_used: z.number().optional(),
    credits: z.number().optional(),
  })
  .passthrough();
export type LeadsListResponse = z.infer<typeof leadsListResponseSchema>;

/** Pull the leads array regardless of which documented key carries it. */
export function leadsFrom(parsed: LeadsListResponse): Array<Record<string, unknown>> {
  return parsed.items ?? parsed.leads ?? parsed.data ?? [];
}

/** Map Instantly's native verification vocabulary to our normalized status. */
export function normalizeInstantlyVerification(raw: string | null | undefined): EnrichmentVerificationStatus {
  const s = (raw ?? '').trim().toLowerCase();
  if (s === 'valid' || s === 'verified' || s === 'deliverable') return 'VERIFIED';
  if (s === 'accept_all' || s === 'catch_all' || s === 'catchall') return 'CATCH_ALL';
  if (s === 'risky' || s === 'unknown_deliverable') return 'RISKY';
  if (s === 'invalid' || s === 'undeliverable') return 'INVALID';
  if (s === '') return 'NOT_FOUND';
  return 'UNKNOWN';
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const numv = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/** First present verification-status field on a lead row (docs vary the key). */
function readVerificationStatus(lead: Record<string, unknown>): string | null {
  const ev = lead['email_verification'];
  if (ev && typeof ev === 'object' && 'status' in ev) {
    const s = str((ev as Record<string, unknown>)['status']);
    if (s !== null) return s;
  }
  return (
    str(lead['email_verification_status']) ??
    str(lead['verification_status']) ??
    str(lead['email_status']) ??
    str(lead['esp_verification'])
  );
}

export interface ExtractedLead {
  email: string;
  verification: EnrichmentVerificationStatus;
  identity: ReturnedIdentity;
  dataQuality: string | null;
  confidence: number | null;
}

/**
 * Extract email + verification + identity from ONE returned lead. THROWS `INSTANTLY_SCHEMA_MISMATCH`
 * (with the observed keys, no values) when a lead is returned but has no recognizable email or
 * verification field — so the caller stops rather than guessing or accepting an unverifiable address.
 */
export function extractLead(lead: Record<string, unknown>): ExtractedLead {
  const email = str(lead['work_email']) ?? str(lead['email']);
  if (!email) {
    throw new AppError('INSTANTLY_SCHEMA_MISMATCH', `Returned lead has no recognizable email field. Keys: ${Object.keys(lead).sort().join(',')}`);
  }
  const rawStatus = readVerificationStatus(lead);
  if (rawStatus === null) {
    throw new AppError('INSTANTLY_SCHEMA_MISMATCH', `Returned lead has an email but no recognizable verification status field. Keys: ${Object.keys(lead).sort().join(',')}`);
  }
  const ev = (lead['email_verification'] && typeof lead['email_verification'] === 'object') ? (lead['email_verification'] as Record<string, unknown>) : {};
  const identity: ReturnedIdentity = {
    name: str(lead['name']) ?? str(lead['full_name']),
    firstName: str(lead['first_name']),
    lastName: str(lead['last_name']),
    domain: str(lead['company_domain']) ?? str(lead['organization_domain']) ?? str(lead['domain']),
    title: str(lead['title']) ?? str(lead['job_title']) ?? str(lead['headline']),
  };
  return {
    email,
    verification: normalizeInstantlyVerification(rawStatus),
    identity,
    dataQuality: str(lead['data_quality']),
    confidence: numv(lead['confidence']) ?? numv(ev['score']),
  };
}
