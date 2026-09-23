import { z } from 'zod';
import { AUDIT_CATEGORIES, PROFILES, SEVERITIES } from './audit-types.js';

export const AUDIT_SCHEMA_VERSION = 'audit-schema-1';

// --- Zod validators (post-call structured-output validation) ---

export const generatorFindingSchema = z.object({
  findingRef: z.string().min(1).max(16),
  category: z.enum(AUDIT_CATEGORIES),
  observation: z.string().min(1).max(600),
  evidenceIds: z.array(z.string().min(1)).min(1).max(12),
  affectedUrls: z.array(z.string()).max(6),
  affectedProfiles: z.array(z.enum(PROFILES)).max(2),
  severity: z.enum(SEVERITIES),
  confidence: z.number().min(0).max(1),
  businessImpact: z.string().min(1).max(600),
  recommendation: z.string().min(1).max(600),
  safeForOutreach: z.boolean(),
  outreachAngle: z.string().max(400).nullable(),
  uncertainty: z.string().max(400).nullable(),
});

export const auditGeneratorOutputSchema = z.object({
  summary: z.string().max(1200),
  findings: z.array(generatorFindingSchema).max(12),
  insufficientEvidenceAreas: z.array(z.string().max(200)).max(20),
  conflictingEvidence: z.array(z.string().max(200)).max(20),
  captureLimitations: z.array(z.string().max(200)).max(20),
});
export type AuditGeneratorOutputParsed = z.infer<typeof auditGeneratorOutputSchema>;

export const findingReviewSchema = z.object({
  findingRef: z.string().min(1).max(16),
  decision: z.enum(['APPROVE', 'REVISE', 'REJECT']),
  evidenceSupported: z.boolean(),
  impactSupported: z.boolean(),
  safeForOutreach: z.boolean(),
  problems: z.array(z.string().max(300)).max(20),
  revisedObservation: z.string().max(600).nullable(),
  revisedBusinessImpact: z.string().max(600).nullable(),
  revisedRecommendation: z.string().max(600).nullable(),
  revisedOutreachAngle: z.string().max(400).nullable(),
});

export const auditReviewOutputSchema = z.object({
  findings: z.array(findingReviewSchema).max(12),
  overallDecision: z.enum(['APPROVE', 'APPROVE_WITH_REVISIONS', 'REJECT', 'MANUAL_REVIEW']),
});
export type AuditReviewOutputParsed = z.infer<typeof auditReviewOutputSchema>;

/**
 * Single source of truth for field length limits. The Zod validators above and the
 * strict JSON schemas below MUST agree: Structured Outputs supports `maxLength`, so
 * the model is told the bound up front instead of only failing validation afterwards.
 * A mismatch here is what caused `schema_invalid:conflictingEvidence.0` (a 244-char
 * item against an undeclared 200-char cap).
 */
export const LIMITS = {
  findingRef: 16,
  observation: 600,
  businessImpact: 600,
  recommendation: 600,
  outreachAngle: 400,
  uncertainty: 400,
  summary: 1200,
  metadataItem: 200,
  reviewProblem: 300,
} as const;

/** Fields safe to clamp deterministically: descriptive metadata only, never a finding claim. */
export const NORMALIZABLE_METADATA_ARRAYS = ['insufficientEvidenceAreas', 'conflictingEvidence', 'captureLimitations'] as const;

/**
 * Clamp to `max` characters on a word boundary, marking the cut with an ellipsis so a
 * shortened value is never mistaken for the model's complete text. Falls back to a hard
 * cut when there is no sensible space to break on (e.g. one very long token).
 */
export function truncateAtWordBoundary(value: string, max: number): string {
  if (value.length <= max) return value;
  const ellipsis = '…';
  const budget = max - ellipsis.length;
  const head = value.slice(0, budget);
  const lastSpace = head.lastIndexOf(' ');
  let cut = lastSpace > Math.floor(budget * 0.6) ? head.slice(0, lastSpace) : head;
  cut = cut.trimEnd();
  while (cut.length > 0 && (cut.endsWith(',') || cut.endsWith(';') || cut.endsWith(':'))) {
    cut = cut.slice(0, -1).trimEnd();
  }
  return cut + ellipsis;
}

/**
 * Deterministically clamp ONLY descriptive metadata (summary + the three commentary
 * arrays) to their declared limits before Zod validation, so an over-long note cannot
 * discard an otherwise valid, already-paid-for audit.
 *
 * Substantive finding content (observation, businessImpact, recommendation,
 * outreachAngle, uncertainty) is deliberately NOT touched: silently shortening a claim
 * would change what the audit asserts, so those still fail validation loudly.
 */
export function normalizeGeneratorMetadata(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  if (typeof out.summary === 'string') out.summary = truncateAtWordBoundary(out.summary, LIMITS.summary);
  for (const key of NORMALIZABLE_METADATA_ARRAYS) {
    const arr = out[key];
    if (!Array.isArray(arr)) continue;
    out[key] = arr.map((item) => (typeof item === 'string' ? truncateAtWordBoundary(item, LIMITS.metadataItem) : item));
  }
  return out;
}

// --- Strict JSON schemas for the Responses API (text.format json_schema, strict:true) ---

const strObj = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: 'object',
  additionalProperties: false,
  required,
  properties,
});

const generatorFindingJson = strObj(
  {
    findingRef: { type: 'string', maxLength: LIMITS.findingRef },
    category: { type: 'string', enum: [...AUDIT_CATEGORIES] },
    observation: { type: 'string', maxLength: LIMITS.observation },
    evidenceIds: { type: 'array', items: { type: 'string' }, maxItems: 12 },
    affectedUrls: { type: 'array', items: { type: 'string' }, maxItems: 6 },
    affectedProfiles: { type: 'array', items: { type: 'string', enum: [...PROFILES] }, maxItems: 2 },
    severity: { type: 'string', enum: [...SEVERITIES] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    businessImpact: { type: 'string', maxLength: LIMITS.businessImpact },
    recommendation: { type: 'string', maxLength: LIMITS.recommendation },
    safeForOutreach: { type: 'boolean' },
    outreachAngle: { type: ['string', 'null'], maxLength: LIMITS.outreachAngle },
    uncertainty: { type: ['string', 'null'], maxLength: LIMITS.uncertainty },
  },
  [
    'findingRef', 'category', 'observation', 'evidenceIds', 'affectedUrls', 'affectedProfiles',
    'severity', 'confidence', 'businessImpact', 'recommendation', 'safeForOutreach', 'outreachAngle', 'uncertainty',
  ],
);

export const GENERATOR_JSON_SCHEMA = strObj(
  {
    summary: { type: 'string', maxLength: LIMITS.summary },
    findings: { type: 'array', items: generatorFindingJson, maxItems: 12 },
    insufficientEvidenceAreas: { type: 'array', items: { type: 'string', maxLength: LIMITS.metadataItem }, maxItems: 20 },
    conflictingEvidence: { type: 'array', items: { type: 'string', maxLength: LIMITS.metadataItem }, maxItems: 20 },
    captureLimitations: { type: 'array', items: { type: 'string', maxLength: LIMITS.metadataItem }, maxItems: 20 },
  },
  ['summary', 'findings', 'insufficientEvidenceAreas', 'conflictingEvidence', 'captureLimitations'],
);

const findingReviewJson = strObj(
  {
    findingRef: { type: 'string', maxLength: LIMITS.findingRef },
    decision: { type: 'string', enum: ['APPROVE', 'REVISE', 'REJECT'] },
    evidenceSupported: { type: 'boolean' },
    impactSupported: { type: 'boolean' },
    safeForOutreach: { type: 'boolean' },
    problems: { type: 'array', items: { type: 'string', maxLength: LIMITS.reviewProblem }, maxItems: 20 },
    revisedObservation: { type: ['string', 'null'], maxLength: LIMITS.observation },
    revisedBusinessImpact: { type: ['string', 'null'], maxLength: LIMITS.businessImpact },
    revisedRecommendation: { type: ['string', 'null'], maxLength: LIMITS.recommendation },
    revisedOutreachAngle: { type: ['string', 'null'], maxLength: LIMITS.outreachAngle },
  },
  [
    'findingRef', 'decision', 'evidenceSupported', 'impactSupported', 'safeForOutreach', 'problems',
    'revisedObservation', 'revisedBusinessImpact', 'revisedRecommendation', 'revisedOutreachAngle',
  ],
);

export const REVIEWER_JSON_SCHEMA = strObj(
  {
    findings: { type: 'array', items: findingReviewJson, maxItems: 12 },
    overallDecision: { type: 'string', enum: ['APPROVE', 'APPROVE_WITH_REVISIONS', 'REJECT', 'MANUAL_REVIEW'] },
  },
  ['findings', 'overallDecision'],
);
