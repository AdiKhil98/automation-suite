import { type Logger } from 'pino';
import { type LeadFact } from '../../domain/lead-facts/lead-fact.js';
import { type EnrichmentContext } from '../../domain/enrichment/types.js';
import { placeDetailsCostUsd, type PlacesDetailsClient } from './google-places-details.js';
import {
  type EnrichmentContextProvider,
  type LeadEnrichmentInput,
  type ProviderCapabilities,
} from './provider.js';

function factValue(facts: LeadFact[], type: string): string | null {
  return facts.find((f) => f.factType === type && f.isCurrent)?.value ?? null;
}

/** Context from the lead's own durable (mock/manual/website) facts. No cost. */
export class FactsContextProvider implements EnrichmentContextProvider {
  readonly name = 'facts';
  readonly capabilities: ProviderCapabilities = {
    returnsFields: ['business_name', 'phone', 'formatted_address', 'city', 'country'],
    persistableFields: ['business_name', 'phone', 'formatted_address', 'city', 'country'],
    ephemeralFields: [],
    canIncurCost: false,
  };

  async contextFor(input: LeadEnrichmentInput): Promise<EnrichmentContext | null> {
    const f = (t: string): string | null => factValue(input.currentFacts, t);
    const businessName = f('business_name');
    const phone = f('phone');
    const formattedAddress = f('formatted_address');
    const hints: string[] = [];
    const officialUrl = f('official_website_url');
    const official = f('official_domain');
    const domain = f('domain');
    if (officialUrl) hints.push(officialUrl);
    else if (official) hints.push(`https://${official}`);
    else if (domain) hints.push(`https://${domain}`);
    if (!businessName && !phone && !formattedAddress && hints.length === 0) return null;
    return { businessName, phone, formattedAddress, city: f('city'), country: f('country'), candidateUrls: hints };
  }
}

/** Context from operator-supplied CLI/CSV input. No cost. */
export class ManualContextProvider implements EnrichmentContextProvider {
  readonly name = 'manual';
  readonly capabilities: ProviderCapabilities = {
    returnsFields: ['business_name', 'phone', 'formatted_address', 'city', 'country', 'candidate_urls'],
    persistableFields: [],
    ephemeralFields: [],
    canIncurCost: false,
  };

  async contextFor(input: LeadEnrichmentInput): Promise<EnrichmentContext | null> {
    const m = input.manual;
    if (!m) return null;
    const hints = m.candidateUrls ?? [];
    if (!m.businessName && !m.phone && !m.formattedAddress && hints.length === 0) return null;
    return {
      businessName: m.businessName ?? null,
      phone: m.phone ?? null,
      formattedAddress: m.formattedAddress ?? null,
      city: m.city ?? null,
      country: m.country ?? null,
      candidateUrls: hints,
    };
  }
}

/** Fixture-backed context for tests. */
export class MockContextProvider implements EnrichmentContextProvider {
  readonly name = 'mock';
  readonly capabilities: ProviderCapabilities = {
    returnsFields: ['business_name', 'phone', 'formatted_address', 'candidate_urls'],
    persistableFields: [],
    ephemeralFields: [],
    canIncurCost: false,
  };
  constructor(private readonly byKey: Map<string, EnrichmentContext>) {}
  async contextFor(input: LeadEnrichmentInput): Promise<EnrichmentContext | null> {
    return this.byKey.get(input.placeId ?? input.leadId) ?? null;
  }
}

/** Per-run budget for paid Google reads (counts + estimated cost). */
export interface GoogleReadBudget {
  requests: number;
  estimatedCostUsd: number;
  maxRequests: number;
  maxCostUsd: number | null;
}

export interface GoogleContextOptions {
  client: PlacesDetailsClient;
  allowPaidReads: boolean;
  budget: GoogleReadBudget;
  logger: Logger;
}

/**
 * OPTIONAL production context provider. Uses Place Details (New) BY PLACE ID to get
 * in-memory identification/discovery context. All returned values are EPHEMERAL and
 * must never be persisted; only a returned websiteUri is used as a candidate hint
 * that still requires official-site verification. Disabled unless ALLOW_PAID_READS.
 */
export class GoogleContextProvider implements EnrichmentContextProvider {
  readonly name = 'google';
  readonly capabilities: ProviderCapabilities = {
    returnsFields: ['displayName', 'formattedAddress', 'nationalPhoneNumber', 'websiteUri'],
    persistableFields: [], // NONE — all Google-derived context is ephemeral
    ephemeralFields: ['displayName', 'formattedAddress', 'nationalPhoneNumber', 'websiteUri'],
    canIncurCost: true,
  };

  constructor(private readonly opts: GoogleContextOptions) {}

  async contextFor(input: LeadEnrichmentInput): Promise<EnrichmentContext | null> {
    if (!input.placeId) return null;
    if (!this.opts.allowPaidReads) {
      this.opts.logger.info({ placeId: input.placeId }, 'google context disabled (ALLOW_PAID_READS=false)');
      return null;
    }
    const b = this.opts.budget;
    const projectedCost = placeDetailsCostUsd(b.requests + 1);
    if (b.requests >= b.maxRequests || (b.maxCostUsd !== null && projectedCost > b.maxCostUsd)) {
      this.opts.logger.warn({ requests: b.requests, cap: b.maxRequests }, 'google read budget reached; skipping');
      return null;
    }
    const details = await this.opts.client.details(input.placeId);
    b.requests += 1;
    b.estimatedCostUsd = placeDetailsCostUsd(b.requests);
    // Log only non-restricted accounting — never names/addresses/phones/urls.
    this.opts.logger.info(
      { placeId: input.placeId, requests: b.requests, estimatedCostUsd: b.estimatedCostUsd },
      'google context read',
    );
    if (!details) return null;
    const hints = details.websiteUri ? [details.websiteUri] : [];
    return {
      businessName: details.displayName ?? null,
      phone: details.nationalPhoneNumber ?? null,
      formattedAddress: details.formattedAddress ?? null,
      city: null,
      country: null,
      candidateUrls: hints,
    };
  }
}
