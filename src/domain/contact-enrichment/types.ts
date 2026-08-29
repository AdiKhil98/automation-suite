import { z } from 'zod';

/**
 * Contact enrichment domain types. The goal is narrow and deterministic:
 *   business domain + a KNOWN decision-maker (name + title) -> a VERIFIED professional work email.
 *
 * Provider-agnostic. Instantly is the first concrete provider; Hunter/Apollo can be added later
 * behind {@link ContactEnrichmentProvider} without touching this module.
 */

/** One decision-maker candidate to try, in operator-provided priority order. */
export interface CandidatePerson {
  /** Full display name exactly as observed on the official site, e.g. "Dr Shyam Shastri". */
  fullName: string;
  firstName: string;
  lastName: string;
  /** Exact role title observed, e.g. "Principal Dentist". */
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

/**
 * Verification status vocabulary, normalized across providers. Only VERIFIED is ever acceptable
 * for autonomous outreach — everything else fails closed. `RISKY`/`CATCH_ALL`/`UNKNOWN` are
 * explicitly NOT good enough; `GENERIC_REJECTED` marks a role/mailbox address (info@, admin@ …)
 * that we refuse regardless of provider verification.
 */
export const ENRICHMENT_VERIFICATION_STATUSES = [
  'VERIFIED',
  'RISKY',
  'CATCH_ALL',
  'INVALID',
  'UNKNOWN',
  'GENERIC_REJECTED',
  'NOT_FOUND',
] as const;
export type EnrichmentVerificationStatus = (typeof ENRICHMENT_VERIFICATION_STATUSES)[number];

/**
 * Identity of the person the provider actually returned, extracted from the retrieved lead. The
 * trust boundary validates this against the REQUESTED candidate (name + domain + title) before any
 * email is accepted — the provider never decides acceptance.
 */
export interface ReturnedIdentity {
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  domain: string | null;
  title: string | null;
}

/** Normalized outcome of ONE paid provider lookup (before the accept/reject decision). */
export interface ProviderEnrichmentOutcome {
  /** Whichever candidate this outcome is for. */
  query: EnrichmentQuery;
  /** The email the provider returned, or null. May still be rejected below. */
  email: string | null;
  /** Identity of the returned lead, for exact person/domain/title validation. Null when none found. */
  returnedIdentity: ReturnedIdentity | null;
  /** Provider-native verification, normalized to our vocabulary. */
  verificationStatus: EnrichmentVerificationStatus;
  /** Provider-native data-quality/confidence signal, preserved verbatim (e.g. "high", score). */
  dataQuality: string | null;
  /** Numeric confidence in [0,1] when the provider supplies one; else null. */
  confidence: number | null;
  /** Credits the provider reports charged for this lookup (0 for estimate/mock). */
  creditsUsed: number;
  /** Provider resource/job id for provenance (async enrichment), or null. */
  resourceId: string | null;
  /** The exact endpoint hit, for provenance. */
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

/** Terminal outcome of a whole enrichment run over the ordered candidate list. */
export const CONTACT_ENRICHMENT_OUTCOMES = ['VERIFIED', 'NOT_FOUND', 'CAPPED', 'ERROR'] as const;
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
  creditsUsed: number;
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
