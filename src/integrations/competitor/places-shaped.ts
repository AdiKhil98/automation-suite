import { type CompetitorInputCandidate } from '../../domain/competitor/types.js';

/**
 * Google Places-shaped record (a subset of the Places Details "New" contract). Phase 7A1 never
 * calls Places live — this shape lets fixtures/CSV reuse the SAME field contract a future,
 * explicitly-approved live adapter would map from, so downstream code is provider-agnostic.
 */
export interface PlacesShapedCandidate {
  id: string | null; // Place ID (provider candidate id)
  displayName: string | null;
  websiteUri: string | null;
  primaryType: string | null;
  types: string[];
  location: { latitude: number | null; longitude: number | null } | null;
  formattedAddress: string | null;
  city: string | null;
  market: string | null;
  languageCode: string | null;
  businessType: string | null;
  parentBrand: string | null;
  branchId: string | null;
}

/** Pure adapter: Places-shaped records → domain input candidates. No network. */
export function fromPlacesShaped(records: readonly PlacesShapedCandidate[]): CompetitorInputCandidate[] {
  return records.map((r, i) => ({
    rowIndex: i + 1,
    providerCandidateId: r.id,
    businessName: r.displayName,
    website: r.websiteUri,
    primaryCategory: r.primaryType,
    secondaryCategories: [...r.types],
    latitude: r.location?.latitude ?? null,
    longitude: r.location?.longitude ?? null,
    address: r.formattedAddress,
    city: r.city,
    market: r.market,
    language: r.languageCode,
    businessType: r.businessType,
    parentBrand: r.parentBrand,
    branchId: r.branchId,
  }));
}
