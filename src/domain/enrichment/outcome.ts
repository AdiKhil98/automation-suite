import { type LeadStatus } from '../leads/status.js';

/** Full enrichment outcome taxonomy. Lead-level FAILED is reserved for internal
 * unrecoverable errors and is NOT part of this taxonomy. */
export const ENRICHMENT_OUTCOMES = [
  'VERIFIED',
  'AMBIGUOUS',
  'INSUFFICIENT_CONTEXT',
  'NO_CANDIDATE',
  'NO_VERIFIED_CANDIDATE',
  'BROWSER_REQUIRED',
  'TRANSIENT_ERROR',
  'POLICY_BLOCKED',
  'INVALID_INPUT',
] as const;
export type EnrichmentOutcome = (typeof ENRICHMENT_OUTCOMES)[number];

export const CANDIDATE_DECISIONS = ['VERIFIED', 'REJECTED', 'AMBIGUOUS'] as const;
export type CandidateDecision = (typeof CANDIDATE_DECISIONS)[number];

export const DISCOVERY_SOURCES = [
  'website_hint',
  'directory',
  'search',
  'social',
  'google_hint',
  'manual',
  'mock',
] as const;
export type DiscoverySource = (typeof DISCOVERY_SOURCES)[number];

export const SIGNAL_TYPES = [
  'exact_phone',
  'name_address',
  'branch_location',
  'structured_data',
  'legal_footer',
  'name_tokens',
  'category_text',
  'city_mention',
  'mailto',
  'plaintext_email',
  'contact_form',
  // Narrow deterministic fallback: the candidate URL was supplied by Google Places AND several
  // exact identity checks (same registrable domain, on-page name + city, niche category, and a
  // deterministic domain↔name match) all agree. See scoreCandidate for the fail-closed conditions.
  'places_website_identity_match',
] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];

/** Signals that, on their own, can support VERIFIED (given confidence). */
export const STRONG_SIGNALS: readonly SignalType[] = [
  'exact_phone',
  'name_address',
  'branch_location',
  'structured_data',
  'legal_footer',
  'places_website_identity_match',
];

/**
 * Map an enrichment outcome to the resulting lead state, or `null` to keep the
 * lead in READY_FOR_ENRICHMENT (no transition). Exactly the approved routing.
 */
export function routeOutcome(outcome: EnrichmentOutcome): LeadStatus | null {
  switch (outcome) {
    case 'VERIFIED':
      return 'READY_FOR_QUALIFICATION'; // via ENRICHED (two-step; see service)
    case 'AMBIGUOUS':
    case 'NO_VERIFIED_CANDIDATE':
    case 'BROWSER_REQUIRED':
    case 'POLICY_BLOCKED':
    case 'INVALID_INPUT':
      return 'NEEDS_MANUAL_REVIEW';
    case 'INSUFFICIENT_CONTEXT':
    case 'NO_CANDIDATE':
    case 'TRANSIENT_ERROR':
      return null; // remain READY_FOR_ENRICHMENT
  }
}
