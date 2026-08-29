import { z } from 'zod';

/**
 * Contact enrichment domain types. Goal: business domain + a KNOWN decision-maker (name + title) ->
 * a VERIFIED professional work email, spending an enrichment credit ONLY after a non-enriching
 * preview/search confirms the person exists at the domain and matches locally.
 *
 * Provider-agnostic. Instantly is the first concrete provider; Hunter/Apollo can be added later
 * behind the same interface without touching this module.
 */

/** One decision-maker candidate to try, in operator-provided priority order. */
export interface CandidatePerson {
  fullName: string;
  firstName: string;
  lastName: string;
  title: string;
  /** 1 = preferred; larger = fallback. Determines try order. */
  priority: number;
}

/** A single provider lookup query for one known person at one company domain. */
export interface EnrichmentQuery {
  domain: string;
  fullName: string;
  firstName: string;
  lastName: string;
  title: string;
}

/** Normalized verification vocabulary. Only VERIFIED is ever acceptable for autonomous outreach. */
export const ENRICHMENT_VERIFICATION_STATUSES = [
  'VERIFIED', 'RISKY', 'CATCH_ALL', 'INVALID', 'UNKNOWN', 'GENERIC_REJECTED', 'NOT_FOUND',
] as const;
export type EnrichmentVerificationStatus = (typeof ENRICHMENT_VERIFICATION_STATUSES)[number];

/**
 * Identity of the person actually returned by the provider (from an enriched lead OR a preview row).
 * The trust boundary validates this against the REQUESTED candidate before anything is accepted.
 */
export interface ReturnedIdentity {
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  domain: string | null;
  title: string | null;
}

/** A person found by the non-enriching preview/search (NO email — enrichment hasn't run). */
export interface PreviewPerson extends ReturnedIdentity {
  /** Provider-native lead/row id, if any (for the subsequent targeted enrichment / provenance). */
  providerLeadId: string | null;
}

/** Result of a non-enriching preview/search over a domain. Credits are provider-reported (or null). */
export interface PreviewResult {
  domain: string;
  people: PreviewPerson[];
  creditsReported: number | null;
  resourceId: string | null;
  endpoint: string;
  rawDigest: string;
}

/** Normalized outcome of ONE paid enrichment lookup (before the accept/reject decision). */
export interface ProviderEnrichmentOutcome {
  query: EnrichmentQuery;
  email: string | null;
  /** Identity of the returned lead, for exact person/domain/title validation. Null when none found. */
  returnedIdentity: ReturnedIdentity | null;
  verificationStatus: EnrichmentVerificationStatus;
  dataQuality: string | null;
  confidence: number | null;
  /** Credits the PROVIDER reported charging for this lookup. `null` = provider reported nothing. */
  creditsReported: number | null;
  resourceId: string | null;
  endpoint: string;
  /** SHA-256 of the raw provider response body (no PII/secret retained verbatim). */
  rawDigest: string;
}

/** Pre-spend availability estimate for one query (plan/dry-run; never charges). */
export interface EnrichmentEstimate {
  query: EnrichmentQuery;
  available: boolean;
  projectedCredits: number;
  endpoint: string;
}

/** Terminal outcome of a whole enrichment run. */
export const CONTACT_ENRICHMENT_OUTCOMES = [
  'VERIFIED', 'NOT_FOUND', 'CAPPED', 'ERROR', 'PREVIEW_MATCHED', 'PREVIEW_NO_MATCH',
] as const;
export type ContactEnrichmentOutcome = (typeof CONTACT_ENRICHMENT_OUTCOMES)[number];

/** The accepted, verified decision-maker contact — the ONLY shape allowed to reach outreach. */
export interface VerifiedContact {
  fullName: string;
  title: string;
  email: string;
  verificationStatus: 'VERIFIED';
  dataQuality: string | null;
  confidence: number | null;
}

/** Persisted result of an enrichment run (mirrors the contact_enrichment_results row). */
export interface ContactEnrichmentResult {
  id: string;
  leadId: string;
  provider: string;
  inputHash: string;
  requestedDomain: string;
  candidates: CandidatePerson[];
  outcome: ContactEnrichmentOutcome;
  accepted: VerifiedContact | null;
  /** Internal ESTIMATE used for cap math (1 per enrichment attempt). Not billing truth. */
  creditsEstimated: number;
  /** Sum of PROVIDER-REPORTED credits across all provider calls; `null` if the provider reported none. */
  creditsReported: number | null;
  providerResourceId: string | null;
  endpoint: string | null;
  provenance: Record<string, unknown>;
  createdAt: Date;
  completedAt: Date | null;
}

export const candidatePersonSchema = z.object({
  fullName: z.string().min(1),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  title: z.string().min(1),
  priority: z.number().int().nonnegative(),
});
