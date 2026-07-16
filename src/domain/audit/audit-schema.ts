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

// --- Strict JSON schemas for the Responses API (text.format json_schema, strict:true) ---

const strObj = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: 'object',
  additionalProperties: false,
  required,
  properties,
});

const generatorFindingJson = strObj(
  {
    findingRef: { type: 'string' },
    category: { type: 'string', enum: [...AUDIT_CATEGORIES] },
    observation: { type: 'string' },
    evidenceIds: { type: 'array', items: { type: 'string' } },
    affectedUrls: { type: 'array', items: { type: 'string' } },
    affectedProfiles: { type: 'array', items: { type: 'string', enum: [...PROFILES] } },
    severity: { type: 'string', enum: [...SEVERITIES] },
    confidence: { type: 'number' },
    businessImpact: { type: 'string' },
    recommendation: { type: 'string' },
    safeForOutreach: { type: 'boolean' },
    outreachAngle: { type: ['string', 'null'] },
    uncertainty: { type: ['string', 'null'] },
  },
  [
    'findingRef', 'category', 'observation', 'evidenceIds', 'affectedUrls', 'affectedProfiles',
    'severity', 'confidence', 'businessImpact', 'recommendation', 'safeForOutreach', 'outreachAngle', 'uncertainty',
  ],
);

export const GENERATOR_JSON_SCHEMA = strObj(
  {
    summary: { type: 'string' },
    findings: { type: 'array', items: generatorFindingJson },
    insufficientEvidenceAreas: { type: 'array', items: { type: 'string' } },
    conflictingEvidence: { type: 'array', items: { type: 'string' } },
    captureLimitations: { type: 'array', items: { type: 'string' } },
  },
  ['summary', 'findings', 'insufficientEvidenceAreas', 'conflictingEvidence', 'captureLimitations'],
);

const findingReviewJson = strObj(
  {
    findingRef: { type: 'string' },
    decision: { type: 'string', enum: ['APPROVE', 'REVISE', 'REJECT'] },
    evidenceSupported: { type: 'boolean' },
    impactSupported: { type: 'boolean' },
    safeForOutreach: { type: 'boolean' },
    problems: { type: 'array', items: { type: 'string' } },
    revisedObservation: { type: ['string', 'null'] },
    revisedBusinessImpact: { type: ['string', 'null'] },
    revisedRecommendation: { type: ['string', 'null'] },
    revisedOutreachAngle: { type: ['string', 'null'] },
  },
  [
    'findingRef', 'decision', 'evidenceSupported', 'impactSupported', 'safeForOutreach', 'problems',
    'revisedObservation', 'revisedBusinessImpact', 'revisedRecommendation', 'revisedOutreachAngle',
  ],
);

export const REVIEWER_JSON_SCHEMA = strObj(
  {
    findings: { type: 'array', items: findingReviewJson },
    overallDecision: { type: 'string', enum: ['APPROVE', 'APPROVE_WITH_REVISIONS', 'REJECT', 'MANUAL_REVIEW'] },
  },
  ['findings', 'overallDecision'],
);
