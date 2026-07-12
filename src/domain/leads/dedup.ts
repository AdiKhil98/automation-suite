import { haversineMeters } from '../../utils/geo.js';
import { normalizeCity } from './normalize.js';

/**
 * Deterministic deduplication engine. Operates on already-normalized fields.
 * Business name is NEVER a merge signal on its own — a match requires a near
 * address as corroboration, so legitimate branches of one business stay separate.
 *
 * Place-ID equality (the strongest tier) is handled by the source_entities
 * uniqueness constraint before this runs; decideMatch covers tiers 2–7.
 */

export type MatchTier =
  | 'DOMAIN_ADDRESS'
  | 'PHONE_ADDRESS'
  | 'NAME_ADDRESS'
  | 'BRANCH'
  | 'AMBIGUOUS'
  | 'NONE';

export interface DedupInput {
  normalizedName: string | null;
  normalizedDomain: string | null;
  normalizedPhone: string | null;
  normalizedAddress: string | null;
  latitude: number | null;
  longitude: number | null;
  city: string | null;
}

export interface DedupCandidate extends DedupInput {
  leadId: string;
}

export type DedupDecision =
  | { kind: 'DUPLICATE'; tier: 'DOMAIN_ADDRESS' | 'PHONE_ADDRESS' | 'NAME_ADDRESS'; leadId: string }
  | { kind: 'BRANCH'; relatedLeadId: string }
  | { kind: 'AMBIGUOUS'; candidateLeadId: string }
  | { kind: 'UNIQUE' };

export interface DedupOptions {
  nearMeters: number;
}

function nearAddress(a: DedupInput, b: DedupInput, nearMeters: number): boolean {
  if (a.normalizedAddress && b.normalizedAddress && a.normalizedAddress === b.normalizedAddress) {
    return true;
  }
  if (
    a.latitude != null &&
    a.longitude != null &&
    b.latitude != null &&
    b.longitude != null
  ) {
    return haversineMeters(a.latitude, a.longitude, b.latitude, b.longitude) <= nearMeters;
  }
  return false;
}

function sameCity(a: DedupInput, b: DedupInput): boolean {
  const ca = normalizeCity(a.city);
  const cb = normalizeCity(b.city);
  return ca != null && cb != null && ca === cb;
}

/**
 * Decide how an incoming record relates to existing candidates. Precedence:
 *   domain+near → phone+near → name+near (DUPLICATE)
 *   → domain/phone at a different address (BRANCH, keep separate)
 *   → name+city only (AMBIGUOUS, flag for review)
 *   → otherwise UNIQUE.
 */
export function decideMatch(
  input: DedupInput,
  candidates: DedupCandidate[],
  opts: DedupOptions,
): DedupDecision {
  const { nearMeters } = opts;

  for (const c of candidates) {
    if (input.normalizedDomain && c.normalizedDomain === input.normalizedDomain && nearAddress(input, c, nearMeters)) {
      return { kind: 'DUPLICATE', tier: 'DOMAIN_ADDRESS', leadId: c.leadId };
    }
  }
  for (const c of candidates) {
    if (input.normalizedPhone && c.normalizedPhone === input.normalizedPhone && nearAddress(input, c, nearMeters)) {
      return { kind: 'DUPLICATE', tier: 'PHONE_ADDRESS', leadId: c.leadId };
    }
  }
  for (const c of candidates) {
    if (input.normalizedName && c.normalizedName === input.normalizedName && nearAddress(input, c, nearMeters)) {
      return { kind: 'DUPLICATE', tier: 'NAME_ADDRESS', leadId: c.leadId };
    }
  }
  // Same strong identifier but a different address => a separate branch, not a merge.
  for (const c of candidates) {
    const sameDomain = input.normalizedDomain != null && c.normalizedDomain === input.normalizedDomain;
    const samePhone = input.normalizedPhone != null && c.normalizedPhone === input.normalizedPhone;
    if ((sameDomain || samePhone) && !nearAddress(input, c, nearMeters)) {
      return { kind: 'BRANCH', relatedLeadId: c.leadId };
    }
  }
  // Same name + same city with no stronger evidence => ambiguous, flag for review.
  for (const c of candidates) {
    if (input.normalizedName && c.normalizedName === input.normalizedName && sameCity(input, c)) {
      return { kind: 'AMBIGUOUS', candidateLeadId: c.leadId };
    }
  }
  return { kind: 'UNIQUE' };
}

/** Extract the dedup-relevant fields from any record carrying them. */
export function toDedupInput(record: DedupInput): DedupInput {
  return {
    normalizedName: record.normalizedName,
    normalizedDomain: record.normalizedDomain,
    normalizedPhone: record.normalizedPhone,
    normalizedAddress: record.normalizedAddress,
    latitude: record.latitude,
    longitude: record.longitude,
    city: record.city,
  };
}
