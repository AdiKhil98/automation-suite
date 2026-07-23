import { z } from 'zod';
import {
  DEMO_ALIGNMENT_RESULTS,
  MAX_SUBJECT_LENGTH,
  PRIMARY_CTAS,
  REVIEW_DECISIONS,
  SCAN_RESULTS,
} from './email-types.js';

export const EMAIL_SCHEMA_VERSION = 'email-copy-schema-2';

export const emailWriterSchema = z.object({
  subject_options: z.array(z.string().trim().min(1).max(MAX_SUBJECT_LENGTH)).length(3),
  selected_subject: z.string().trim().min(1).max(MAX_SUBJECT_LENGTH),
  selected_subject_reason: z.string().trim().min(1).max(400),
  email_body: z.string().trim().min(1).max(2_000),
  evidence_ids: z.array(z.string().trim().min(1).max(128)).min(1).max(12),
  strategic_angle: z.string().trim().min(1).max(400),
  business_relevance: z.string().trim().min(1).max(500),
  urgency_basis: z.string().trim().min(1).max(400),
  competitor_evidence_used: z.literal('NONE'),
  primary_cta: z.enum(PRIMARY_CTAS),
  prohibited_phrase_scan: z.enum(SCAN_RESULTS),
  punctuation_scan: z.enum(SCAN_RESULTS),
  genericity_score: z.number().int().min(0).max(100),
  human_style_result: z.enum(SCAN_RESULTS),
  demo_alignment_result: z.enum(DEMO_ALIGNMENT_RESULTS),
});
export type EmailWriterParsed = z.infer<typeof emailWriterSchema>;

export const emailReviewSchema = z.object({
  decision: z.enum(REVIEW_DECISIONS),
  fabricationRisk: z.boolean(),
  subjectSpecific: z.boolean(),
  openingSpecific: z.boolean(),
  businessRelevanceClear: z.boolean(),
  urgencySupported: z.boolean(),
  competitorClaimsSupported: z.boolean(),
  humanStylePass: z.boolean(),
  punctuationPass: z.boolean(),
  singlePrimaryCta: z.boolean(),
  sufficientlyPersonalized: z.boolean(),
  evidenceSupported: z.boolean(),
  demoAligned: z.boolean(),
  persuasive: z.boolean(),
  problems: z.array(z.string().trim().min(1).max(300)).max(20),
  requiredRevisions: z.array(z.string().trim().min(1).max(300)).max(20),
});
export type EmailReviewParsed = z.infer<typeof emailReviewSchema>;

const strictObject = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: 'object',
  additionalProperties: false,
  required,
  properties,
});

export const EMAIL_WRITER_JSON_SCHEMA = strictObject(
  {
    subject_options: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'string' } },
    selected_subject: { type: 'string' },
    selected_subject_reason: { type: 'string' },
    email_body: { type: 'string' },
    evidence_ids: { type: 'array', items: { type: 'string' } },
    strategic_angle: { type: 'string' },
    business_relevance: { type: 'string' },
    urgency_basis: { type: 'string' },
    competitor_evidence_used: { type: 'string', enum: ['NONE'] },
    primary_cta: { type: 'string', enum: [...PRIMARY_CTAS] },
    prohibited_phrase_scan: { type: 'string', enum: [...SCAN_RESULTS] },
    punctuation_scan: { type: 'string', enum: [...SCAN_RESULTS] },
    genericity_score: { type: 'integer', minimum: 0, maximum: 100 },
    human_style_result: { type: 'string', enum: [...SCAN_RESULTS] },
    demo_alignment_result: { type: 'string', enum: [...DEMO_ALIGNMENT_RESULTS] },
  },
  [
    'subject_options', 'selected_subject', 'selected_subject_reason', 'email_body',
    'evidence_ids', 'strategic_angle', 'business_relevance', 'urgency_basis',
    'competitor_evidence_used', 'primary_cta', 'prohibited_phrase_scan',
    'punctuation_scan', 'genericity_score', 'human_style_result', 'demo_alignment_result',
  ],
);

export const EMAIL_REVIEW_JSON_SCHEMA = strictObject(
  {
    decision: { type: 'string', enum: [...REVIEW_DECISIONS] },
    fabricationRisk: { type: 'boolean' },
    subjectSpecific: { type: 'boolean' },
    openingSpecific: { type: 'boolean' },
    businessRelevanceClear: { type: 'boolean' },
    urgencySupported: { type: 'boolean' },
    competitorClaimsSupported: { type: 'boolean' },
    humanStylePass: { type: 'boolean' },
    punctuationPass: { type: 'boolean' },
    singlePrimaryCta: { type: 'boolean' },
    sufficientlyPersonalized: { type: 'boolean' },
    evidenceSupported: { type: 'boolean' },
    demoAligned: { type: 'boolean' },
    persuasive: { type: 'boolean' },
    problems: { type: 'array', items: { type: 'string' } },
    requiredRevisions: { type: 'array', items: { type: 'string' } },
  },
  [
    'decision', 'fabricationRisk', 'subjectSpecific', 'openingSpecific',
    'businessRelevanceClear', 'urgencySupported', 'competitorClaimsSupported',
    'humanStylePass', 'punctuationPass', 'singlePrimaryCta',
    'sufficientlyPersonalized', 'evidenceSupported', 'demoAligned', 'persuasive',
    'problems', 'requiredRevisions',
  ],
);
