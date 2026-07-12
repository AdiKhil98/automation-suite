import { randomUUID } from 'node:crypto';
import { type Lead } from './lead.js';
import { normalizeAddress, normalizeDomain, normalizeName, normalizePhone } from './normalize.js';

/** Durable business facts sourced from a non-Google provider (mock/manual/website). */
export interface LeadFactsInput {
  businessName: string | null;
  domain: string | null;
  phone: string | null;
  city: string | null;
  country: string | null;
  formattedAddress: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface BuildFactsOptions {
  factsSource: string; // 'mock' | 'manual' | 'website' — never 'google_places'
  factsSourceUrl?: string | null;
  placeId?: string | null;
  source: string; // discovering provider
  now?: Date;
}

/** Build a fully-formed lead from durable facts (mock/manual/enrichment). */
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
    factsSource: opts.factsSource,
    factsSourceUrl: opts.factsSourceUrl ?? null,
    factsCapturedAt: now,
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
    factsSource: null,
    factsSourceUrl: null,
    factsCapturedAt: null,
    dedupStatus: 'UNIQUE',
    duplicateOf: null,
    createdAt: now,
    updatedAt: now,
  };
}
