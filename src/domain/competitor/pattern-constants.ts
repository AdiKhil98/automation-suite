/**
 * Phase 7A3A deterministic competitor-pattern constants. Pure data + rule versions. NO AI, NO email
 * wording composition, NO network. Everything here is operator-locked and reproducible.
 *
 * A "pattern" is a cross-competitor presence count for one evidence category over the SELECTED
 * competitors of one Phase 7A1 research run, using ONLY eligible Phase 7A2 evidence. A "contrast"
 * compares a positive pattern against the prospect's OWN verified evidence for an explicitly mapped
 * category. Nothing here composes, drafts, or sends email.
 */

import { type EvidenceCategory } from './evidence-types.js';

/** Bumped when any deterministic pattern/contrast/denominator/wording rule changes. */
export const COMPETITOR_PATTERN_RULES_VERSION = 'competitor-pattern-2026-08-01';

/** Internal pattern result for one category (never surfaced verbatim to email). */
export const PATTERN_RESULTS = ['ALL_OBSERVED', 'MAJORITY_OBSERVED', 'NO_PATTERN', 'INSUFFICIENT_DATA'] as const;
export type PatternResult = (typeof PATTERN_RESULTS)[number];

/** The two positive presence results that may support a contrast / enter an approvable package. */
export const POSITIVE_PATTERN_RESULTS: ReadonlySet<PatternResult> = new Set(['ALL_OBSERVED', 'MAJORITY_OBSERVED']);

/** Package lifecycle. Approval never happens automatically; history is immutable. */
export const PACKAGE_STATUSES = ['DRAFT', 'REVIEWED', 'APPROVED', 'REJECTED', 'SUPERSEDED', 'INVALIDATED'] as const;
export type PackageStatus = (typeof PACKAGE_STATUSES)[number];

/** Deterministic confidence band, shared with the evidence layer. */
export const PATTERN_CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type PatternConfidence = (typeof PATTERN_CONFIDENCES)[number];

/** Per-brand classification for one category. Only PRESENT + ABSENT enter the denominator. */
export const PRESENCE_STATES = ['PRESENT', 'ABSENT', 'UNKNOWN'] as const;
export type PresenceState = (typeof PRESENCE_STATES)[number];

/** Anonymized, count-bound wording form. Competitor names are NEVER part of any external wording. */
export const WORDING_FORMS = ['TWO_OF_TWO', 'TWO_OF_THREE', 'ALL_OF_THREE', 'NONE'] as const;
export type WordingForm = (typeof WORDING_FORMS)[number];

/** Cautious, non-performance consequence categories. Never a factual performance/volume claim. */
export const CONSEQUENCE_LABELS = [
  'CONTACT_DISCOVERABILITY',
  'BOOKING_DISCOVERABILITY',
  'INFORMATION_ACCESS',
  'NAVIGATION_FRICTION',
  'TRUST_INFORMATION_VISIBILITY',
  'LOCATION_INFORMATION_ACCESS',
] as const;
export type ConsequenceLabel = (typeof CONSEQUENCE_LABELS)[number];

/** Why a candidate evidence item was excluded from aggregation (persisted for auditability). */
export const EXCLUSION_REASONS = [
  'NOT_SELECTED_CANDIDATE',
  'CAPTURE_SUPERSEDED',
  'EVIDENCE_INACTIVE',
  'STALE',
  'LOW_CONFIDENCE',
  'NOT_SAFE_FOR_OUTREACH',
  'MISSING_SOURCE_URL',
  'CATEGORY_NOT_APPROVED',
  'UNSUPPORTED_INFERENCE',
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

/**
 * The depth categories are numeric, not boolean presence. They may form an internal median summary
 * but — in Phase 7A3A — never produce a prospect contrast (no verified prospect depth is stored).
 */
export const DEPTH_CATEGORIES: ReadonlySet<EvidenceCategory> = new Set(['MOBILE_NAVIGATION_DEPTH', 'CONTACT_PATH_DEPTH']);

/**
 * Categories whose ABSENCE can be VERIFIED from the bounded captured pages (an above-the-fold /
 * homepage-viewport control that a deterministic detector fully inspects within a defined scope).
 * ONLY these categories may ever be classified ABSENT, and ONLY when an explicit, scoped negative
 * observation exists (never from "no evidence row").
 *
 * Every other category (TEAM_OR_PRACTITIONER_INFORMATION, PRICING_OR_FINANCING_INFORMATION,
 * FAQ_CONTENT_VISIBLE, SERVICE_INFORMATION_VISIBLE, OPENING_HOURS_VISIBLE, LOCATION_VISIBLE,
 * ON_SITE_TESTIMONIAL_OR_REVIEW_SECTION, LANGUAGE_SUPPORT_VISIBLE, …) requires site-wide inspection
 * that a ≤2-page capture cannot prove, so its absence is ALWAYS UNKNOWN — site-wide absence is never
 * inferred from a homepage-only or bounded capture. Depth categories are numeric and never ABSENT.
 */
export const ABSENT_CAPABLE_CATEGORIES: ReadonlySet<EvidenceCategory> = new Set([
  'PHONE_VISIBLE',
  'BOOKING_CTA_VISIBLE',
  'WHATSAPP_OR_DIRECT_MESSAGE_VISIBLE',
  'MOBILE_STICKY_CONTACT_CONTROL',
]);

/**
 * Explicit, operator-approved mapping from a competitor evidence category to the prospect's OWN
 * deterministic capture-evidence proxy. ONLY these categories may produce a boolean prospect contrast.
 * Every unmapped category stays a competitor-only internal pattern (never contrasted, never external).
 *
 * The prospect side (Phase 5 `capture_evidence`) stores low-level DOM primitives, not semantic
 * presence facts — so per the "withhold rather than invent a mapping" rule, only the unambiguous
 * proxies below are mapped. `prospectEvidenceTypes` are the `capture_evidence.evidence_type` values
 * that count as PRESENT; `messagingHostOnly` narrows link matching to known direct-message hosts.
 */
export interface ProspectCategoryMapping {
  category: EvidenceCategory;
  prospectEvidenceTypes: readonly string[];
  /** When true, a matching `link` ref must point at a known messaging host to count as present. */
  messagingHostOnly?: boolean;
  consequence: ConsequenceLabel;
}

export const MESSAGING_HOSTS: readonly string[] = ['wa.me', 'api.whatsapp.com', 'web.whatsapp.com', 'whatsapp.com', 'm.me', 'messenger.com'];

export const PROSPECT_CATEGORY_MAPPINGS: readonly ProspectCategoryMapping[] = [
  { category: 'PHONE_VISIBLE', prospectEvidenceTypes: ['tel'], consequence: 'CONTACT_DISCOVERABILITY' },
  {
    category: 'WHATSAPP_OR_DIRECT_MESSAGE_VISIBLE',
    prospectEvidenceTypes: ['link', 'mailto'],
    messagingHostOnly: true,
    consequence: 'CONTACT_DISCOVERABILITY',
  },
  { category: 'BOOKING_CTA_VISIBLE', prospectEvidenceTypes: ['cta', 'form'], consequence: 'BOOKING_DISCOVERABILITY' },
  // NOTE: the two DEPTH categories (MOBILE_NAVIGATION_DEPTH, CONTACT_PATH_DEPTH) are intentionally
  // NOT mapped. They are numeric on the competitor side and there is no stored verified prospect
  // depth measurement, so per the operator decision their prospect contrasts are withheld entirely.
] as const;

const MAPPING_BY_CATEGORY = new Map<EvidenceCategory, ProspectCategoryMapping>(
  PROSPECT_CATEGORY_MAPPINGS.map((m) => [m.category, m]),
);

/** The explicit mapping for a category, or null when none exists (→ competitor-only internal). */
export function prospectMappingFor(category: EvidenceCategory): ProspectCategoryMapping | null {
  return MAPPING_BY_CATEGORY.get(category) ?? null;
}

/** Human-safe description templates keyed by consequence label. Cautious, never performance. */
export const CONSEQUENCE_DESCRIPTIONS: Record<ConsequenceLabel, string> = {
  CONTACT_DISCOVERABILITY: 'requires additional navigation before direct contact is available',
  BOOKING_DISCOVERABILITY: 'may make booking less immediately discoverable',
  INFORMATION_ACCESS: 'places key service information deeper in the site',
  NAVIGATION_FRICTION: 'requires additional interaction to reach the same information',
  TRUST_INFORMATION_VISIBILITY: 'shows trust information less prominently',
  LOCATION_INFORMATION_ACCESS: 'places key location information deeper in the site',
};

/**
 * Prohibited claim lexicon. Any of these substrings appearing in wording/consequence text is a HARD
 * validation FAILURE (never a warning) — defense in depth against performance/volume/ranking language
 * and subjective competitor judgments leaking into an outreach-bound package.
 */
export const PROHIBITED_CLAIM_TERMS: readonly string[] = [
  'loses customers',
  'lose customers',
  'reduces conversion',
  'reduce conversion',
  'more conversions',
  'convert better',
  'converts better',
  'higher conversion',
  'costs revenue',
  'cost revenue',
  'lost revenue',
  'hurts ranking',
  'hurt ranking',
  'better ranking',
  'ranks higher',
  'rank higher',
  'rank better',
  'drives more bookings',
  'drive more bookings',
  'more bookings',
  'customers prefer',
  'customer prefer',
  'best performing',
  'best-performing',
  'top competitor',
  'industry leader',
  'market leader',
  'the market',
  'most successful',
  'outperform',
  'more traffic',
  'more customers',
  'increase sales',
  'boost sales',
];
