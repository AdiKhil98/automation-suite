/**
 * Phase 7A1 deterministic comparability constants. These encode the EXACT operator-approved
 * scoring model (docs/phase-7a-competitor-research.md §6.2, operator decision 2026-08-01).
 *
 * NO weight here may be changed without a new recorded operator decision + a bump of
 * COMPARABILITY_RULES_VERSION. There are no hidden defaults; identical normalized input always
 * yields the identical score.
 */

/** Bumped whenever any weight, gate, or threshold below changes. Persisted on every run. */
export const COMPARABILITY_RULES_VERSION = 'comp-cmp-1';

/** Acceptance threshold (inclusive). Score 69 rejects; score 70 accepts. */
export const MIN_COMPARABILITY = 70;

/** Category component (45 max). */
export const CATEGORY_EXACT_POINTS = 45;
export const CATEGORY_RELATED_POINTS = 25;

/** Service-overlap component (20 max): 5 points per unique overlapping service, capped at 4. */
export const SERVICE_POINTS_PER_MATCH = 5;
export const SERVICE_MAX_MATCHES = 4;
export const SERVICE_MAX_POINTS = SERVICE_POINTS_PER_MATCH * SERVICE_MAX_MATCHES; // 20

/** Proximity component (15 max). Distances in kilometres. */
export const PROXIMITY_PRIMARY_KM = 5.0;
export const PROXIMITY_FALLBACK_KM = 10.0;
export const PROXIMITY_WITHIN_PRIMARY_POINTS = 15; // distance <= 5.0 km
export const PROXIMITY_WITHIN_FALLBACK_POINTS = 8; // 5.0 km < distance <= 10.0 km

/** Business-type component (10 max). */
export const BUSINESS_TYPE_SAME_POINTS = 10;
export const BUSINESS_TYPE_MISMATCH_POINTS = 5;
export const BUSINESS_TYPE_UNKNOWN_POINTS = 0;

/** Market + language component (10 max total). */
export const MARKET_SAME_POINTS = 6;
export const MARKET_UNKNOWN_POINTS = 0;
export const LANGUAGE_SAME_POINTS = 4;
export const LANGUAGE_OTHER_POINTS = 0;

/** Location-count similarity is deferred entirely to a later milestone (0 points in 7A1). */
export const LOCATION_COUNT_POINTS = 0;

/** Maximum competitors selected per prospect. */
export const MAX_SELECTED_COMPETITORS = 3;

/**
 * Explicit category-relationship groups. Two DISTINCT normalized categories are RELATED iff they
 * appear in the same group. Unknown relationships are NEVER treated as related (they become WEAK).
 * Values are compared after normalizeName() (lowercase, collapsed whitespace).
 */
export const RELATED_CATEGORY_GROUPS: readonly (readonly string[])[] = [
  ['dentist', 'dental clinic', 'dental practice', 'orthodontist', 'cosmetic dentist', 'oral surgeon'],
  ['physiotherapist', 'physiotherapy clinic', 'sports clinic', 'rehabilitation clinic', 'osteopath'],
  ['general practitioner', 'medical clinic', 'family clinic', 'private gp', 'health centre'],
  ['dermatologist', 'skin clinic', 'aesthetic clinic', 'cosmetic clinic', 'medspa'],
  ['optician', 'optometrist', 'eye clinic'],
  ['veterinarian', 'veterinary clinic', 'animal hospital'],
  ['law firm', 'solicitor', 'legal practice', 'attorney'],
  ['accountant', 'accounting firm', 'bookkeeping service', 'tax advisor'],
  ['hair salon', 'barber shop', 'beauty salon'],
  ['restaurant', 'cafe', 'bistro'],
];

/**
 * Registrable domains that are never eligible competitors (directories, marketplaces, aggregators,
 * review sites, and social-only profiles). Detected deterministically from the supplied website.
 */
export const NON_ELIGIBLE_DOMAINS: ReadonlySet<string> = new Set([
  // social-only
  'facebook.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com', 'tiktok.com',
  'youtube.com', 'pinterest.com', 'wa.me',
  // directories / marketplaces / aggregators / review sites
  'google.com', 'goo.gl', 'maps.google.com', 'bing.com', 'yelp.com', 'yell.com',
  'tripadvisor.com', 'tripadvisor.co.uk', 'trustpilot.com', 'foursquare.com',
  'checkatrade.com', 'thomsonlocal.com', 'doctolib.de', 'jameda.de', 'treatwell.co.uk',
  'booking.com', 'thumbtack.com', 'houzz.com',
]);

/**
 * Supplied category/business-type tokens that mark a candidate as a non-eligible listing type
 * regardless of domain (e.g. an explicit "directory" record).
 */
export const NON_ELIGIBLE_TYPE_TOKENS: ReadonlySet<string> = new Set([
  'directory', 'marketplace', 'aggregator', 'social', 'social media', 'review site', 'listing',
]);
