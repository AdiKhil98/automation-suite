/**
 * Phase 7A4A — competitor email quality validation constants (deterministic; no I/O). Thresholds and
 * rubric weights are the operator-approved values recorded in docs/phase-7a4-email-validation.md.
 */

export const COMPETITOR_EMAIL_VALIDATION_RULES_VERSION = 'competitor-email-validation-2026-08-03';

export const COMPETITOR_EVIDENCE_MODE_APPROVED = 'APPROVED_COMPETITOR_PATTERN_PACKAGE' as const;
export const COMPETITOR_EVIDENCE_MODE_NONE = 'NONE' as const;

/** Concrete issue keywords for the BOOKING_FRICTION primary issue (booking discoverability). */
export const ISSUE_KEYWORDS: readonly string[] = ['booking', 'appointment', 'book'];

/** Exact approved rubric category weights (sum = 100). */
export const RUBRIC_WEIGHTS = {
  prospectSpecificity: 20,
  materialRelevance: 20,
  integrity: 20,
  clarity: 15,
  brevity: 10,
  recommendationCta: 10,
  naturalness: 5,
} as const;

/** Approved acceptance thresholds for the ENRICHED email. */
export const ACCEPTANCE = {
  minTotal: 80,
  minImprovementOverBaseline: 8,
  minMaterialRelevance: 16,
  requiredIntegrity: 20,
} as const;

/** Per-paragraph readability bound (characters). */
export const MAX_PARAGRAPH_CHARS = 400;
/** Max words in the model body (matches the copy gate's MAX_EMAIL_WORDS). */
export const MAX_MODEL_BODY_WORDS = 120;
