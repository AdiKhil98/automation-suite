import { z } from 'zod';
import {
  CTA_KINDS,
  CTA_LABEL_KEYS,
  EMAIL_FACT_KEYS,
  GREETING_STYLES,
  MAX_BODY_PARAGRAPHS,
  REVIEW_DECISIONS,
  SIGNOFF_KEYS,
} from './email-types.js';

export const EMAIL_SCHEMA_VERSION = 'email-schema-1';

// --- Zod validators (post-call structured-output validation) ---

export const emailWriterSchema = z.object({
  subject: z.string().min(1).max(80),
  bodyParagraphs: z.array(z.string().min(1).max(600)).min(1).max(MAX_BODY_PARAGRAPHS),
  greetingStyle: z.enum(GREETING_STYLES),
  ctaKind: z.enum(CTA_KINDS),
  ctaLabelKey: z.enum(CTA_LABEL_KEYS),
  signoffKey: z.enum(SIGNOFF_KEYS),
  factRefs: z.array(z.enum(EMAIL_FACT_KEYS)).max(EMAIL_FACT_KEYS.length),
  findingRefs: z.array(z.string().min(1).max(16)).max(5),
});
export type EmailWriterParsed = z.infer<typeof emailWriterSchema>;

export const emailReviewSchema = z.object({
  decision: z.enum(REVIEW_DECISIONS),
  fabricationRisk: z.boolean(),
  personalizationSupported: z.boolean(),
  claimHonest: z.boolean(),
  revisionRequiresNewFacts: z.boolean(),
  revisionRequiresNewClaims: z.boolean(),
  revisionRequiresCtaChange: z.boolean(),
  problems: z.array(z.string().max(300)).max(20),
});
export type EmailReviewParsed = z.infer<typeof emailReviewSchema>;

// --- Strict JSON schemas for the Responses API (json_schema, strict:true) ---

const strObj = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: 'object',
  additionalProperties: false,
  required,
  properties,
});

export const EMAIL_WRITER_JSON_SCHEMA = strObj(
  {
    subject: { type: 'string' },
    bodyParagraphs: { type: 'array', items: { type: 'string' } },
    greetingStyle: { type: 'string', enum: [...GREETING_STYLES] },
    ctaKind: { type: 'string', enum: [...CTA_KINDS] },
    ctaLabelKey: { type: 'string', enum: [...CTA_LABEL_KEYS] },
    signoffKey: { type: 'string', enum: [...SIGNOFF_KEYS] },
    factRefs: { type: 'array', items: { type: 'string', enum: [...EMAIL_FACT_KEYS] } },
    findingRefs: { type: 'array', items: { type: 'string' } },
  },
  ['subject', 'bodyParagraphs', 'greetingStyle', 'ctaKind', 'ctaLabelKey', 'signoffKey', 'factRefs', 'findingRefs'],
);

export const EMAIL_REVIEW_JSON_SCHEMA = strObj(
  {
    decision: { type: 'string', enum: [...REVIEW_DECISIONS] },
    fabricationRisk: { type: 'boolean' },
    personalizationSupported: { type: 'boolean' },
    claimHonest: { type: 'boolean' },
    revisionRequiresNewFacts: { type: 'boolean' },
    revisionRequiresNewClaims: { type: 'boolean' },
    revisionRequiresCtaChange: { type: 'boolean' },
    problems: { type: 'array', items: { type: 'string' } },
  },
  ['decision', 'fabricationRisk', 'personalizationSupported', 'claimHonest', 'revisionRequiresNewFacts', 'revisionRequiresNewClaims', 'revisionRequiresCtaChange', 'problems'],
);
