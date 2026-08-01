import { haversineMeters } from '../../utils/geo.js';
import { normalizeName } from '../leads/normalize.js';
import { classifyCategoryMatch } from './category.js';
import {
  BUSINESS_TYPE_MISMATCH_POINTS,
  BUSINESS_TYPE_SAME_POINTS,
  BUSINESS_TYPE_UNKNOWN_POINTS,
  CATEGORY_EXACT_POINTS,
  CATEGORY_RELATED_POINTS,
  LANGUAGE_OTHER_POINTS,
  LANGUAGE_SAME_POINTS,
  LOCATION_COUNT_POINTS,
  MARKET_SAME_POINTS,
  MARKET_UNKNOWN_POINTS,
  MIN_COMPARABILITY,
  NON_ELIGIBLE_DOMAINS,
  NON_ELIGIBLE_TYPE_TOKENS,
  PROXIMITY_PRIMARY_KM,
  PROXIMITY_WITHIN_FALLBACK_POINTS,
  PROXIMITY_WITHIN_PRIMARY_POINTS,
  SERVICE_MAX_MATCHES,
  SERVICE_POINTS_PER_MATCH,
} from './constants.js';
import {
  normalizeBrand,
  normalizeDomain,
  normalizeServices,
  overlappingServiceCount,
  registrableDomain,
} from './normalize.js';
import {
  type CategoryMatch,
  type CompetitorInputCandidate,
  type Confidence,
  type EvaluatedCandidate,
  type GateResult,
  type ProspectProfileInput,
  type RejectionReason,
  type ScoreComponent,
} from './types.js';

/** Prospect prepared once per run (normalized), reused for every candidate. */
export interface PreparedProspect {
  leadId: string;
  normalizedDomain: string | null;
  registrable: string | null;
  normalizedName: string | null;
  normalizedParentBrand: string | null;
  normalizedCategory: string | null;
  normalizedServices: string[];
  normalizedMarket: string | null;
  normalizedLanguage: string | null;
  normalizedBusinessType: string | null;
  latitude: number | null;
  longitude: number | null;
  normalizedCity: string | null;
}

export function prepareProspect(profile: ProspectProfileInput): PreparedProspect {
  return {
    leadId: profile.leadId,
    normalizedDomain: normalizeDomain(profile.website),
    registrable: registrableDomain(profile.website),
    normalizedName: normalizeName(profile.website),
    normalizedParentBrand: normalizeBrand(profile.parentBrand),
    normalizedCategory: normalizeName(profile.primaryCategory),
    normalizedServices: normalizeServices(profile.secondaryCategories),
    normalizedMarket: normalizeName(profile.market),
    normalizedLanguage: normalizeName(profile.language),
    normalizedBusinessType: normalizeName(profile.businessType),
    latitude: profile.latitude,
    longitude: profile.longitude,
    normalizedCity: normalizeName(profile.city),
  };
}

interface NormalizedCandidate {
  normalizedDomain: string | null;
  registrable: string | null;
  normalizedName: string | null;
  normalizedParentBrand: string | null;
  brandKey: string;
  normalizedCategory: string | null;
  normalizedServices: string[];
  normalizedMarket: string | null;
  normalizedLanguage: string | null;
  normalizedBusinessType: string | null;
}

export function normalizeCandidate(input: CompetitorInputCandidate): NormalizedCandidate {
  const normalizedDomain = normalizeDomain(input.website);
  const normalizedParentBrand = normalizeBrand(input.parentBrand);
  // Brand key groups a chain's branches together; an independent business is its own brand.
  const brandKey = normalizedParentBrand ?? normalizedDomain ?? `row:${String(input.rowIndex)}`;
  return {
    normalizedDomain,
    registrable: registrableDomain(input.website),
    normalizedName: normalizeName(input.businessName),
    normalizedParentBrand,
    brandKey,
    normalizedCategory: normalizeName(input.primaryCategory),
    normalizedServices: normalizeServices(input.secondaryCategories),
    normalizedMarket: normalizeName(input.market),
    normalizedLanguage: normalizeName(input.language),
    normalizedBusinessType: normalizeName(input.businessType),
  };
}

function computeConfidence(
  prospect: PreparedProspect,
  cand: NormalizedCandidate,
  distanceMeters: number | null,
): Confidence {
  const categorySupplied = cand.normalizedCategory !== null;
  const coordsSupplied = distanceMeters !== null;
  const servicesSupplied = prospect.normalizedServices.length > 0 && cand.normalizedServices.length > 0;
  const businessTypeSupplied = cand.normalizedBusinessType !== null;
  const marketSupplied = cand.normalizedMarket !== null;
  if (categorySupplied && coordsSupplied && servicesSupplied && businessTypeSupplied && marketSupplied) {
    return 'HIGH';
  }
  if (categorySupplied && coordsSupplied && (servicesSupplied || businessTypeSupplied || marketSupplied)) {
    return 'MEDIUM';
  }
  return 'LOW';
}

/**
 * Deterministically evaluate one candidate against the prospect at a given active radius (km).
 * Applies pre-scoring gates first (reject before any points), then the exact 100-point model,
 * then the threshold + category + confidence acceptance rule. No AI, no hidden defaults.
 */
export function scoreCandidate(
  prospect: PreparedProspect,
  input: CompetitorInputCandidate,
  activeRadiusKm: number,
): EvaluatedCandidate {
  const cand = normalizeCandidate(input);
  const gates: GateResult[] = [];
  const distanceMeters =
    input.latitude !== null &&
    input.longitude !== null &&
    prospect.latitude !== null &&
    prospect.longitude !== null
      ? haversineMeters(prospect.latitude, prospect.longitude, input.latitude, input.longitude)
      : null;

  const base = {
    input,
    normalizedDomain: cand.normalizedDomain,
    normalizedName: cand.normalizedName,
    normalizedParentBrand: cand.normalizedParentBrand,
    brandKey: cand.brandKey,
    normalizedPrimaryCategory: cand.normalizedCategory,
    normalizedServices: cand.normalizedServices,
    distanceMeters,
  };

  const reject = (
    gate: string,
    reason: RejectionReason,
    detail: string,
    categoryMatch: CategoryMatch | null = null,
  ): EvaluatedCandidate => {
    gates.push({ gate, passed: false, detail });
    return {
      ...base,
      categoryMatch,
      comparabilityScore: null,
      confidence: null,
      scoreBreakdown: [],
      gateResults: gates,
      disposition: 'REJECTED',
      rejectionReason: reason,
      reasonDetail: detail,
      acceptanceRank: null,
    };
  };

  const pass = (gate: string, detail: string): void => {
    gates.push({ gate, passed: true, detail });
  };

  // --- Pre-scoring gates (reject before scoring) ---
  if (input.malformedReasons && input.malformedReasons.length > 0) {
    return reject('malformed_input', 'MALFORMED_INPUT', `malformed source row: ${input.malformedReasons.join('; ')}`);
  }
  if (!cand.normalizedDomain) {
    return reject('valid_website', 'INVALID_WEBSITE', 'no valid normalized business website/domain');
  }
  pass('valid_website', `normalized domain ${cand.normalizedDomain}`);

  if (
    (prospect.normalizedDomain && cand.normalizedDomain === prospect.normalizedDomain) ||
    (prospect.normalizedName && cand.normalizedName === prospect.normalizedName &&
      prospect.normalizedCity !== null && normalizeName(input.city) === prospect.normalizedCity)
  ) {
    return reject('prospect_self', 'PROSPECT_SELF', 'candidate is the prospect itself or an alternate listing of it');
  }
  pass('prospect_self', 'distinct from prospect identity');

  if (
    (prospect.registrable && cand.registrable === prospect.registrable) ||
    (prospect.normalizedParentBrand && cand.normalizedParentBrand === prospect.normalizedParentBrand)
  ) {
    return reject('prospect_branch', 'PROSPECT_BRANCH', 'candidate is an alternate branch/brand of the prospect');
  }
  pass('prospect_branch', 'not a prospect branch');

  const typeToken = normalizeName(input.businessType);
  const catToken = normalizeName(input.primaryCategory);
  const nonEligibleByDomain = cand.registrable !== null && NON_ELIGIBLE_DOMAINS.has(cand.registrable);
  const nonEligibleByType =
    (typeToken !== null && NON_ELIGIBLE_TYPE_TOKENS.has(typeToken)) ||
    (catToken !== null && NON_ELIGIBLE_TYPE_TOKENS.has(catToken));
  if (nonEligibleByDomain || nonEligibleByType) {
    return reject('eligible_listing', 'NON_ELIGIBLE_LISTING', 'directory/marketplace/aggregator/social-only profile');
  }
  pass('eligible_listing', 'eligible business listing');

  if (
    prospect.normalizedMarket !== null &&
    cand.normalizedMarket !== null &&
    cand.normalizedMarket !== prospect.normalizedMarket
  ) {
    return reject('market', 'MARKET_MISMATCH', `market differs (prospect=${prospect.normalizedMarket}, candidate=${cand.normalizedMarket})`);
  }

  const categoryMatch = classifyCategoryMatch(prospect.normalizedCategory, cand.normalizedCategory);
  if (categoryMatch === 'WEAK' || categoryMatch === 'NONE') {
    return reject('category', 'WEAK_CATEGORY_MATCH', `category match ${categoryMatch}`, categoryMatch);
  }
  pass('category', `category match ${categoryMatch}`);

  const overlap = overlappingServiceCount(prospect.normalizedServices, cand.normalizedServices);
  if (categoryMatch === 'RELATED') {
    const required = Math.min(2, prospect.normalizedServices.length);
    const meaningful =
      prospect.normalizedServices.length >= 1 && cand.normalizedServices.length >= 1 && overlap >= required;
    if (!meaningful) {
      return reject(
        'service_overlap',
        'INSUFFICIENT_SERVICE_OVERLAP',
        `related category requires ${String(required)} overlapping service(s); found ${String(overlap)}`,
        categoryMatch,
      );
    }
    pass('service_overlap', `${String(overlap)} overlapping service(s) (required ${String(required)})`);
  }

  if (distanceMeters === null) {
    return reject('geography', 'MISSING_COORDINATES', 'missing prospect/candidate coordinates', categoryMatch);
  }
  const distanceKm = distanceMeters / 1000;
  if (distanceKm > activeRadiusKm) {
    return reject('geography', 'OUT_OF_RADIUS', `distance ${distanceKm.toFixed(2)} km exceeds active radius ${activeRadiusKm.toFixed(1)} km`, categoryMatch);
  }
  pass('geography', `distance ${distanceKm.toFixed(2)} km within ${activeRadiusKm.toFixed(1)} km`);

  // --- Exact 100-point model ---
  const breakdown: ScoreComponent[] = [];

  const categoryPoints = categoryMatch === 'EXACT' ? CATEGORY_EXACT_POINTS : CATEGORY_RELATED_POINTS;
  breakdown.push({ component: 'CATEGORY', points: categoryPoints, maxPoints: CATEGORY_EXACT_POINTS, detail: `category ${categoryMatch}` });

  const matchedForPoints = Math.min(overlap, SERVICE_MAX_MATCHES);
  const servicePoints = matchedForPoints * SERVICE_POINTS_PER_MATCH;
  breakdown.push({ component: 'SERVICE_OVERLAP', points: servicePoints, maxPoints: SERVICE_MAX_MATCHES * SERVICE_POINTS_PER_MATCH, detail: `${String(overlap)} overlapping service(s), scored ${String(matchedForPoints)}` });

  const proximityPoints = distanceKm <= PROXIMITY_PRIMARY_KM ? PROXIMITY_WITHIN_PRIMARY_POINTS : PROXIMITY_WITHIN_FALLBACK_POINTS;
  breakdown.push({ component: 'PROXIMITY', points: proximityPoints, maxPoints: PROXIMITY_WITHIN_PRIMARY_POINTS, detail: `${distanceKm.toFixed(2)} km` });

  let businessTypePoints: number;
  if (cand.normalizedBusinessType === null || prospect.normalizedBusinessType === null) {
    businessTypePoints = BUSINESS_TYPE_UNKNOWN_POINTS;
  } else if (cand.normalizedBusinessType === prospect.normalizedBusinessType) {
    businessTypePoints = BUSINESS_TYPE_SAME_POINTS;
  } else {
    businessTypePoints = BUSINESS_TYPE_MISMATCH_POINTS;
  }
  breakdown.push({ component: 'BUSINESS_TYPE', points: businessTypePoints, maxPoints: BUSINESS_TYPE_SAME_POINTS, detail: `prospect=${prospect.normalizedBusinessType ?? 'unknown'}, candidate=${cand.normalizedBusinessType ?? 'unknown'}` });

  const marketPoints =
    prospect.normalizedMarket !== null && cand.normalizedMarket !== null && cand.normalizedMarket === prospect.normalizedMarket
      ? MARKET_SAME_POINTS
      : MARKET_UNKNOWN_POINTS;
  breakdown.push({ component: 'MARKET', points: marketPoints, maxPoints: MARKET_SAME_POINTS, detail: `prospect=${prospect.normalizedMarket ?? 'unknown'}, candidate=${cand.normalizedMarket ?? 'unknown'}` });

  const languagePoints =
    prospect.normalizedLanguage !== null && cand.normalizedLanguage !== null && cand.normalizedLanguage === prospect.normalizedLanguage
      ? LANGUAGE_SAME_POINTS
      : LANGUAGE_OTHER_POINTS;
  breakdown.push({ component: 'LANGUAGE', points: languagePoints, maxPoints: LANGUAGE_SAME_POINTS, detail: `prospect=${prospect.normalizedLanguage ?? 'unknown'}, candidate=${cand.normalizedLanguage ?? 'unknown'}` });

  breakdown.push({ component: 'LOCATION_COUNT', points: LOCATION_COUNT_POINTS, maxPoints: 0, detail: 'deferred to a later milestone (0 points in 7A1)' });

  const score = categoryPoints + servicePoints + proximityPoints + businessTypePoints + marketPoints + languagePoints + LOCATION_COUNT_POINTS;
  const confidence = computeConfidence(prospect, cand, distanceMeters);

  const evaluated: EvaluatedCandidate = {
    ...base,
    categoryMatch,
    comparabilityScore: score,
    confidence,
    scoreBreakdown: breakdown,
    gateResults: gates,
    disposition: 'REJECTED',
    rejectionReason: null,
    reasonDetail: '',
    acceptanceRank: null,
  };

  if (score < MIN_COMPARABILITY) {
    return { ...evaluated, rejectionReason: 'BELOW_THRESHOLD', reasonDetail: `score ${String(score)} < threshold ${String(MIN_COMPARABILITY)}` };
  }
  if (confidence === 'LOW') {
    return { ...evaluated, rejectionReason: 'LOW_CONFIDENCE', reasonDetail: `score ${String(score)} but confidence LOW (cannot accept)` };
  }
  // Passed threshold + category + confidence. Selection may still cap/brand-limit it.
  return {
    ...evaluated,
    disposition: 'ACCEPTED',
    rejectionReason: null,
    reasonDetail: `score ${String(score)}, ${categoryMatch}, confidence ${confidence}`,
  };
}
