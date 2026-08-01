/**
 * Phase 7A2 competitor-evidence domain types. Narrow, reproducible, presence/absence facts captured
 * from public competitor website pages. NO comparative patterns, NO email wording, NO prospect-vs-
 * competitor statements (those belong to Phase 7A3). NO AI — every field is set by deterministic code.
 */

import { type CapturePageRole, type CaptureMethod, type CaptureProvider } from './capture-constants.js';

/**
 * Approved evidence category taxonomy (operator-locked for 7A2). Each category has an explicit
 * deterministic detector (see evidence-rules.ts). Categories describe PAGE BEHAVIOUR / PRESENCE ONLY
 * — never visual quality, professionalism, attractiveness, or business performance.
 */
export const EVIDENCE_CATEGORIES = [
  'BOOKING_CTA_VISIBLE',
  'PHONE_VISIBLE',
  'WHATSAPP_OR_DIRECT_MESSAGE_VISIBLE',
  'MOBILE_STICKY_CONTACT_CONTROL',
  'SERVICE_INFORMATION_VISIBLE',
  'LOCATION_VISIBLE',
  'OPENING_HOURS_VISIBLE',
  'TEAM_OR_PRACTITIONER_INFORMATION',
  'ON_SITE_TESTIMONIAL_OR_REVIEW_SECTION',
  'PRICING_OR_FINANCING_INFORMATION',
  'EMERGENCY_OR_URGENT_SERVICE_MESSAGE',
  'LANGUAGE_SUPPORT_VISIBLE',
  'FAQ_CONTENT_VISIBLE',
  'MOBILE_NAVIGATION_DEPTH',
  'CONTACT_PATH_DEPTH',
] as const;
export type EvidenceCategory = (typeof EVIDENCE_CATEGORIES)[number];

/**
 * How an observation was derived. UNSUPPORTED_INFERENCE is NEVER stored as active/usable evidence —
 * it is the defense-in-depth bucket for anything that would imply performance/volume/ranking.
 */
export const OBSERVATION_KINDS = ['DIRECT_OBSERVATION', 'DETERMINISTIC_INTERPRETATION', 'UNSUPPORTED_INFERENCE'] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

/** Deterministic confidence band. Only HIGH or MEDIUM may become safe-for-outreach. */
export const EVIDENCE_CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type EvidenceConfidence = (typeof EVIDENCE_CONFIDENCES)[number];

/** Freshness relative to capturedAt + max-age window. */
export const FRESHNESS_STATUSES = ['FRESH', 'STALE', 'UNREPRODUCIBLE'] as const;
export type FreshnessStatus = (typeof FRESHNESS_STATUSES)[number];

/** Why a captured/attempted observation was withheld (persisted for auditability; never active). */
export const WITHHOLDING_REASONS = [
  'SOURCE_URL_UNREPRODUCIBLE',
  'PAGE_INACCESSIBLE',
  'PAGE_INCOMPLETE',
  'AMBIGUOUS',
  'LOCATOR_UNREPRODUCIBLE',
  'LOGIN_GATED',
  'COOKIE_WALL',
  'CONTRADICTORY',
  'ORIGIN_CHANGED',
  'LIMIT_EXCEEDED',
  'PERFORMANCE_INFERENCE',
  'LOW_CONFIDENCE',
  'STALE',
] as const;
export type WithholdingReason = (typeof WITHHOLDING_REASONS)[number];

/** Capture run lifecycle status (immutable/versioned; superseded, never deleted). */
export type CaptureRunStatus = 'DRAFT' | 'SUPERSEDED';

export type CaptureRunOutcome =
  | 'CAPTURED'
  | 'PARTIAL'
  | 'NO_ELIGIBLE_COMPETITORS'
  | 'ALL_INACCESSIBLE'
  | 'GUARD_FAILED';

/** One raw rendered page consumed by the deterministic detectors (never persisted verbatim). */
export interface CapturedPageInput {
  requestedUrl: string;
  finalUrl: string;
  role: CapturePageRole;
  profile: 'desktop' | 'mobile';
  ok: boolean;
  html: string;
  /** Neutral, non-subjective error kinds (e.g. auth_required, bot_challenge). */
  errorKinds: string[];
}

/**
 * A single deterministic observation before persistence-shaping. `active` items become
 * competitor_evidence_items with safeForOutreach computed; withheld items are persisted with a
 * reason but never marked active.
 */
export interface EvidenceObservation {
  competitorCandidateId: string;
  evidenceCategory: EvidenceCategory;
  observationKind: ObservationKind;
  observation: string; // neutral, factual, non-comparative
  sourcePageUrl: string;
  normalizedOrigin: string;
  selector: string | null;
  sourceExcerpt: string | null; // bounded, redacted; may be null
  profile: 'desktop' | 'mobile';
  /** Numeric attribute for depth categories (nav steps / contact-path clicks). */
  numericValue: number | null;
  confidence: EvidenceConfidence;
  withholdingReason: WithholdingReason | null;
}

/** Fully evaluated, persistence-ready evidence item. */
export interface CompetitorEvidenceItem extends EvidenceObservation {
  id: string;
  captureRunId: string;
  capturedAt: Date;
  captureMethod: CaptureMethod;
  provider: CaptureProvider;
  rulesVersion: string;
  freshnessStatus: FreshnessStatus;
  safeForOutreach: boolean;
  active: boolean;
  evidenceHash: string;
}
