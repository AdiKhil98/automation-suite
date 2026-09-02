import { z } from 'zod';
import { AppError } from '../../utils/errors.js';
import { type EnrichmentQuery, type EnrichmentVerificationStatus, type PreviewPerson, type ReturnedIdentity } from '../../domain/contact-enrichment/types.js';

/**
 * Apollo.io API v1 — People Search (free, non-enriching preview) + People Match (paid, per-person
 * enrich) contract. Endpoint paths and the `q_organization_domains_list` field name are per the
 * operator's own spec. UNLIKE the Instantly/Hunter schema modules, the exact response field names below
 * are Apollo's documented/commonly-observed shape but have NOT been live-call-verified in this session
 * (no live Apollo call has been made). Parsing is deliberately defensive/multi-key-tolerant (mirroring
 * Instantly's readVerificationStatus/leadsFrom style) so minor real-world shape variance doesn't crash,
 * but any genuinely unrecognized shape still throws (never guesses). Run the free People Search canary
 * to confirm the real response shape before trusting a live People Match call.
 *
 *   PEOPLE SEARCH (free, synchronous, 0 credits, non-enriching):
 *     POST /api/v1/mixed_people/api_search
 *       body: { q_organization_domains_list: [domain], page: 1, per_page: limit }
 *       -> { people: [{ id, first_name, last_name, name, title, organization: { primary_domain }, ... }] }
 *     Email is never revealed here (Apollo returns an obfuscated placeholder, e.g.
 *     "email_not_unlocked@domain.com", when unlocked=false) — this module never reads an email field
 *     from a search row; PreviewPerson has no email field, so nothing could leak even if it tried.
 *
 *   PEOPLE MATCH (paid, synchronous, per-person enrich):
 *     POST /api/v1/people/match
 *       body: { id } (preferred, when the preview match carried an Apollo person id)
 *          OR { first_name, last_name, domain } (fallback: verified name + company domain)
 *       -> { person: { id, first_name, last_name, name, title, email, email_status,
 *                      organization: { primary_domain }, ... } } | { person: null }
 *
 * Auth: `X-Api-Key: <APOLLO_API_KEY>` header (Apollo's documented convention — distinct from the
 * Bearer auth used by Hunter/Instantly). Base URL: config APOLLO_API_BASE_URL
 * (default https://api.apollo.io/api/v1).
 */

export const APOLLO_ENDPOINTS = {
  /** Free, synchronous, NON-ENRICHING People Search over a domain. 0 credits, no email revealed. */
  peopleSearch: '/mixed_people/api_search',
  /** Paid, synchronous People Match — enrich ONE known person (by id, or name + domain). */
  peopleMatch: '/people/match',
} as const;

/** Build the People Search request body: domain-scoped only, no title filter (matching happens locally
 * so an Apollo-side title filter never destroys recall for a slightly-differently-worded title). */
export function buildPeopleSearchRequestBody(domain: string, limit: number): Record<string, unknown> {
  return { q_organization_domains_list: [domain], page: 1, per_page: limit };
}

/** Build the People Match request body: prefer the Apollo person id from the local preview match;
 * otherwise fall back to verified name + company domain. */
export function buildPeopleMatchRequestBody(query: EnrichmentQuery): Record<string, unknown> {
  if (query.providerLeadId) return { id: query.providerLeadId };
  return { first_name: query.firstName, last_name: query.lastName, domain: query.domain };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const numv = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/** Tolerant of which top-level array key the response uses (`people` is Apollo's documented key). */
export const apolloPeopleSearchResponseSchema = z
  .object({
    people: z.array(z.record(z.string(), z.unknown())).optional(),
    contacts: z.array(z.record(z.string(), z.unknown())).optional(),
    data: z.array(z.record(z.string(), z.unknown())).optional(),
    pagination: z.record(z.string(), z.unknown()).optional(),
    credits_used: z.number().optional(),
    credits: z.number().optional(),
  })
  .passthrough();
export type ApolloPeopleSearchResponse = z.infer<typeof apolloPeopleSearchResponseSchema>;

/** Pull the people array regardless of which documented key carries it. */
export function peopleFrom(parsed: ApolloPeopleSearchResponse): Array<Record<string, unknown>> {
  return parsed.people ?? parsed.contacts ?? parsed.data ?? [];
}

/** Tolerant of `person` (documented) vs `contact`; `person: null`/absent means genuinely no match. */
export const apolloPersonMatchResponseSchema = z
  .object({
    person: z.record(z.string(), z.unknown()).nullable().optional(),
    contact: z.record(z.string(), z.unknown()).nullable().optional(),
    credits_used: z.number().optional(),
    credits: z.number().optional(),
  })
  .passthrough();
export type ApolloPersonMatchResponse = z.infer<typeof apolloPersonMatchResponseSchema>;

/** Read a provider-reported credit count, defensively. `null` = the provider reported none — never fabricated. */
export function readApolloCredits(o: { credits_used?: number; credits?: number }): number | null {
  return typeof o.credits_used === 'number' ? o.credits_used : typeof o.credits === 'number' ? o.credits : null;
}

/** Extract the organization/company domain from a row, tolerant of nesting + key naming. */
function domainOf(row: Record<string, unknown>): string | null {
  const org = row['organization'];
  if (org && typeof org === 'object') {
    const o = org as Record<string, unknown>;
    const fromOrg = str(o['primary_domain']) ?? str(o['domain']) ?? str(o['website_url']);
    if (fromOrg) return fromOrg;
  }
  return str(row['domain']) ?? str(row['organization_domain']) ?? str(row['company_domain']);
}

/**
 * Map ONE People Search row to a PreviewPerson (identity only — Apollo never reveals a usable email in
 * search results, and PreviewPerson's type carries no email field regardless).
 */
export function extractApolloPreviewPerson(row: Record<string, unknown>): PreviewPerson {
  return {
    name: str(row['name']),
    firstName: str(row['first_name']),
    lastName: str(row['last_name']),
    domain: domainOf(row),
    title: str(row['title']) ?? str(row['headline']),
    providerLeadId: str(row['id']),
  };
}

/**
 * Map Apollo's `email_status` vocabulary to our normalized status. Conservative: only an explicit
 * confirmed/verified-type status maps to VERIFIED; anything indicating a guess, extrapolation, or
 * unavailability — or any unrecognized value — fails closed rather than risking a false accept.
 */
export function normalizeApolloEmailStatus(raw: string | null | undefined): EnrichmentVerificationStatus {
  const s = (raw ?? '').trim().toLowerCase();
  if (s === 'verified') return 'VERIFIED';
  if (s === 'accept_all' || s === 'catch_all' || s === 'catchall') return 'CATCH_ALL';
  if (s === 'guessed' || s === 'extrapolated' || s === 'likely to engage') return 'RISKY';
  if (s === 'invalid' || s === 'bounced' || s === 'undeliverable') return 'INVALID';
  if (s === 'unavailable' || s === '') return 'NOT_FOUND';
  return 'UNKNOWN';
}

export interface ExtractedApolloPerson {
  email: string;
  verificationStatus: EnrichmentVerificationStatus;
  identity: ReturnedIdentity;
  dataQuality: string | null;
  confidence: number | null;
  apolloId: string | null;
}

/**
 * Extract a matched person from a People Match response. Returns `null` when Apollo genuinely found
 * nobody (`person` absent/null — NOT an error). THROWS `APOLLO_SCHEMA_MISMATCH` (with the observed
 * keys, no values) only when a person object WAS returned but carries no recognizable email field — so
 * the caller stops instead of guessing or accepting an unverifiable address.
 */
export function extractApolloPerson(parsed: ApolloPersonMatchResponse): ExtractedApolloPerson | null {
  const row = parsed.person ?? parsed.contact;
  if (!row) return null;
  const email = str(row['email']);
  if (!email) {
    throw new AppError('APOLLO_SCHEMA_MISMATCH', `Returned person has no recognizable email field. Keys: ${Object.keys(row).sort().join(',')}`);
  }
  const identity: ReturnedIdentity = {
    name: str(row['name']),
    firstName: str(row['first_name']),
    lastName: str(row['last_name']),
    domain: domainOf(row),
    title: str(row['title']) ?? str(row['headline']),
  };
  return {
    email,
    verificationStatus: normalizeApolloEmailStatus(str(row['email_status'])),
    identity,
    dataQuality: null,
    confidence: numv(row['email_confidence']),
    apolloId: str(row['id']),
  };
}
