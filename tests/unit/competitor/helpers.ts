import { type CompetitorInputCandidate, type ProspectProfileInput } from '../../../src/domain/competitor/types.js';

// London prospect with 4 supplied services (supports the approved 3-match and 4-match examples).
export const PROSPECT_LAT = 51.5074;
export const PROSPECT_LON = -0.1278;

export function prospect(over: Partial<ProspectProfileInput> = {}): ProspectProfileInput {
  return {
    leadId: 'lead-1',
    website: 'https://smileclinic.example',
    primaryCategory: 'dentist',
    secondaryCategories: ['teeth whitening', 'implants', 'invisalign', 'veneers'],
    latitude: PROSPECT_LAT,
    longitude: PROSPECT_LON,
    city: 'London',
    market: 'london',
    language: 'en',
    businessType: 'independent',
    parentBrand: null,
    ...over,
  };
}

let seq = 0;
export function cand(over: Partial<CompetitorInputCandidate> = {}): CompetitorInputCandidate {
  seq += 1;
  return {
    rowIndex: over.rowIndex ?? seq,
    providerCandidateId: null,
    businessName: `Competitor ${String(seq)}`,
    website: `https://competitor${String(seq)}.example`,
    primaryCategory: 'dentist',
    secondaryCategories: [],
    latitude: PROSPECT_LAT,
    longitude: PROSPECT_LON,
    address: null,
    city: 'London',
    market: 'london',
    language: 'en',
    businessType: 'independent',
    parentBrand: null,
    branchId: null,
    ...over,
  };
}

/** Approx latitude offset (degrees) for a target distance in km at the prospect's latitude. */
export function latOffsetKm(km: number): number {
  return km / 111.19; // ~111.19 km per degree latitude
}

/** A candidate placed `km` north of the prospect. */
export function candAtKm(km: number, over: Partial<CompetitorInputCandidate> = {}): CompetitorInputCandidate {
  return cand({ latitude: PROSPECT_LAT + latOffsetKm(km), longitude: PROSPECT_LON, ...over });
}
