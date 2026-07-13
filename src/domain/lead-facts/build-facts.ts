import { type LeadFactsInput } from '../leads/lead-factory.js';
import {
  normalizeAddress,
  normalizeCity,
  normalizeDomain,
  normalizeName,
  normalizePhone,
} from '../leads/normalize.js';
import { type FactSourceType, type FactType, type NewLeadFact } from './lead-fact.js';

interface FactSpec {
  type: FactType;
  value: string;
  normalized: string | null;
}

/**
 * Convert a provider's fact set into lead_fact write inputs. Only present values
 * become facts; normalized values are computed for the identity/dedup types.
 */
export function buildLeadFactInputs(
  leadId: string,
  facts: LeadFactsInput,
  sourceType: FactSourceType,
  sourceUrl: string | null,
): NewLeadFact[] {
  const specs: FactSpec[] = [];
  const push = (type: FactType, value: string | null | undefined, normalized: string | null): void => {
    if (value == null || value === '') return;
    specs.push({ type, value, normalized });
  };

  push('business_name', facts.businessName, normalizeName(facts.businessName));
  push('official_domain', facts.officialDomain ?? null, normalizeDomain(facts.officialDomain ?? null));
  push('domain', facts.domain, normalizeDomain(facts.domain));
  push('phone', facts.phone, normalizePhone(facts.phone));
  push('contact_email', facts.contactEmail ?? null, (facts.contactEmail ?? null)?.trim().toLowerCase() ?? null);
  push('contact_form_url', facts.contactFormUrl ?? null, null);
  push('formatted_address', facts.formattedAddress, normalizeAddress(facts.formattedAddress));
  push('latitude', facts.latitude != null ? String(facts.latitude) : null, null);
  push('longitude', facts.longitude != null ? String(facts.longitude) : null, null);
  push('city', facts.city, normalizeCity(facts.city));
  push('country', facts.country, (facts.country ?? null)?.trim().toUpperCase() ?? null);
  push('category', facts.category ?? null, normalizeName(facts.category ?? null));
  push('rating', facts.rating != null ? String(facts.rating) : null, null);
  push('review_count', facts.reviewCount != null ? String(facts.reviewCount) : null, null);
  push('business_status', facts.businessStatus ?? null, null);
  push('ownership_type', facts.ownershipType ?? null, null);

  return specs.map((s) => ({
    leadId,
    factType: s.type,
    value: s.value,
    normalizedValue: s.normalized,
    sourceType,
    sourceUrl,
  }));
}
