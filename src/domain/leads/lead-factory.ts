import { randomUUID } from 'node:crypto';
import { type Lead } from './lead.js';
import { normalizeAddress, normalizeDomain, normalizeName, normalizePhone } from './normalize.js';

/**
 * Durable business facts sourced from a non-Google provider (mock/manual/website).
 * The identity subset (name/domain/phone/address/coords/city/country) feeds the
 * leads projection; the full set is emitted to lead_facts by the caller.
 */
export interface LeadFactsInput {
  businessName: string | null;
  domain: string | null;
  officialDomain?: string | null;
  phone: string | null;
  contactEmail?: string | null;
  contactFormUrl?: string | null;
  city: string | null;
  country: string | null;
  formattedAddress: string | null;
  latitude: number | null;
  longitude: number | null;
  category?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
  businessStatus?: string | null;
  ownershipType?: string | null;
}

export interface BuildFactsOptions {
  placeId?: string | null;
  source: string; // discovering provider
  now?: Date;
}

/** Build the lead projection from durable facts (provenance lives in lead_facts). */
export function buildLeadFromFacts(facts: LeadFactsInput, opts: BuildFactsOptions): Lead {
  const now = opts.now ?? new Date();
  return {
    id: randomUUID(),
    businessName: facts.businessName,
    normalizedName: normalizeName(facts.businessName),
    domain: facts.domain,
    normalizedDomain: normalizeDomain(facts.domain),
    phone: facts.phone,
    normalizedPhone: normalizePhone(facts.phone),
    formattedAddress: facts.formattedAddress,
    normalizedAddress: normalizeAddress(facts.formattedAddress),
    latitude: facts.latitude,
    longitude: facts.longitude,
    placeId: opts.placeId ?? null,
    city: facts.city,
    country: facts.country,
    status: 'NEW',
    priority: null,
    source: opts.source,
    dedupStatus: 'UNIQUE',
    duplicateOf: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Build a Place-ID-only candidate lead. No business facts are stored — Google
 * discovery is ID-only and its content must not be persisted. Facts arrive later
 * from independent enrichment.
 */
export function buildCandidateLead(opts: { sourcePlaceId: string; source: string; now?: Date }): Lead {
  const now = opts.now ?? new Date();
  return {
    id: randomUUID(),
    businessName: null,
    normalizedName: null,
    domain: null,
    normalizedDomain: null,
    phone: null,
    normalizedPhone: null,
    formattedAddress: null,
    normalizedAddress: null,
    latitude: null,
    longitude: null,
    placeId: opts.sourcePlaceId,
    city: null,
    country: null,
    status: 'NEW',
    priority: null,
    source: opts.source,
    dedupStatus: 'UNIQUE',
    duplicateOf: null,
    createdAt: now,
    updatedAt: now,
  };
}
