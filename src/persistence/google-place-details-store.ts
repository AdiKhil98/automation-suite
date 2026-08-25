import { type FactType, type NewLeadFact } from '../domain/lead-facts/lead-fact.js';
import { normalizeAddress, normalizeName, normalizePhone } from '../domain/leads/normalize.js';
import { type PlaceDetailsStore } from '../integrations/enrichment/context-providers.js';
import { type PlaceDetails } from '../integrations/enrichment/google-places-details.js';
import { AppError } from '../utils/errors.js';
import { type Database } from './db.js';
import { LeadFactsRepository } from './repositories/lead-facts.repo.js';
import { LeadsRepository } from './repositories/leads.repo.js';

function normalized(type: FactType, value: string): string | null {
  if (type === 'business_name') return normalizeName(value);
  if (type === 'formatted_address') return normalizeAddress(value);
  if (type === 'phone') return normalizePhone(value);
  if (type === 'candidate_website_url') {
    try {
      return new URL(value).toString();
    } catch {
      return null;
    }
  }
  return value.trim().toLowerCase();
}

export function buildGooglePlaceFacts(
  leadId: string,
  placeId: string,
  details: PlaceDetails,
  retrievedAt: Date,
  persistApprovedPhone: boolean,
): NewLeadFact[] {
  const sourceUrl = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`;
  const values: Array<[FactType, string | null | undefined]> = [
    ['google_place_id', placeId],
    ['business_name', details.displayName],
    ['candidate_website_url', details.websiteUri],
    ['formatted_address', details.formattedAddress],
    ['city', details.locality],
    ['country', details.country],
    ['category', details.primaryType ?? details.types?.[0]],
    ['business_status', details.businessStatus],
    // Quantitative demand signals, stored as text like every other fact. `userRatingCount`
    // maps to review_count. An explicit 0 rating count is preserved (a genuine "no ratings").
    ['rating', details.rating != null ? String(details.rating) : null],
    ['review_count', details.userRatingCount != null ? String(details.userRatingCount) : null],
    ['phone', persistApprovedPhone ? details.nationalPhoneNumber : null],
  ];
  return values.flatMap(([factType, raw]) => {
    const value = raw?.trim();
    if (!value) return [];
    return [{
      leadId,
      factType,
      value,
      normalizedValue: normalized(factType, value),
      sourceType: 'google_places' as const,
      sourceUrl,
      capturedAt: retrievedAt,
      confidence: 1,
    }];
  });
}

/** Persists successful Place Details independently of later website verification. */
export class DrizzleGooglePlaceDetailsStore implements PlaceDetailsStore {
  constructor(private readonly db: Database) {}

  async persist(input: Parameters<PlaceDetailsStore['persist']>[0]): Promise<number> {
    return this.db.transaction(async (tx) => {
      const lead = await new LeadsRepository(tx).getById(input.leadId);
      if (!lead || lead.placeId !== input.placeId) {
        throw new AppError('PLACE_BINDING_MISMATCH', 'Place Details lead binding mismatch');
      }
      const repo = new LeadFactsRepository(tx);
      let written = 0;
      for (const fact of buildGooglePlaceFacts(
        input.leadId,
        input.placeId,
        input.details,
        input.retrievedAt,
        input.persistApprovedPhone,
      )) {
        const existing = await repo.getCurrentFact(input.leadId, fact.factType);
        if (existing && existing.sourceType !== 'google_places') continue;
        if (existing?.value === fact.value) continue;
        await repo.writeCurrentFact(fact);
        written += 1;
      }
      return written;
    });
  }
}
