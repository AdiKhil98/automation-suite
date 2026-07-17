import { z } from 'zod';
import {
  BODY_COMPONENT_IDS,
  CTA_INTENTS,
  CTA_LABEL_KEYS,
  FACT_KEYS,
  FOOTER_COMPONENT_IDS,
  HEADER_COMPONENT_IDS,
  HERO_STRATEGIES,
  MAX_DEMO_SECTIONS,
  MESSAGING_EMPHASES,
  REVIEW_DECISIONS,
  VISUAL_DIRECTIONS,
} from './design-spec.js';

export const COMPOSER_SCHEMA_VERSION = 'demo-composer-schema-2';

// --- Zod validators (post-call structured-output validation) ---

export const designSpecSectionSchema = z.object({
  componentId: z.enum(BODY_COMPONENT_IDS),
  order: z.number().int().min(1).max(MAX_DEMO_SECTIONS),
  addressesFindingRef: z.string().min(1).max(16).nullable(),
  factKeys: z.array(z.enum(FACT_KEYS)).max(FACT_KEYS.length),
  messagingEmphasis: z.enum(MESSAGING_EMPHASES),
});

export const designSpecSchema = z.object({
  visualDirection: z.enum(VISUAL_DIRECTIONS),
  heroStrategy: z.enum(HERO_STRATEGIES),
  headerVariant: z.enum(HEADER_COMPONENT_IDS),
  footerVariant: z.enum(FOOTER_COMPONENT_IDS),
  primaryCtaIntent: z.enum(CTA_INTENTS),
  primaryCtaLabelKey: z.enum(CTA_LABEL_KEYS),
  secondaryCtaEnabled: z.boolean(),
  sections: z.array(designSpecSectionSchema).min(1).max(MAX_DEMO_SECTIONS),
  mobilePriority: z.array(z.enum(BODY_COMPONENT_IDS)).max(MAX_DEMO_SECTIONS),
  rationale: z.string().max(600),
});
export type DesignSpecParsed = z.infer<typeof designSpecSchema>;

export const designReviewSchema = z.object({
  decision: z.enum(REVIEW_DECISIONS),
  fabricationRisk: z.boolean(),
  evidenceConsistent: z.boolean(),
  ctaHonest: z.boolean(),
  revisionRequiresNewFacts: z.boolean(),
  revisionRequiresNewClaims: z.boolean(),
  revisionRequiresCtaChange: z.boolean(),
  problems: z.array(z.string().max(300)).max(20),
});
export type DesignReviewParsed = z.infer<typeof designReviewSchema>;

// --- Strict JSON schemas for the Responses API (text.format json_schema, strict:true) ---
// Mirrors audit-schema.ts: additionalProperties:false, every property required, nullable
// via ['string','null']. No property anywhere accepts raw markup.

const strObj = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: 'object',
  additionalProperties: false,
  required,
  properties,
});

const sectionJson = strObj(
  {
    componentId: { type: 'string', enum: [...BODY_COMPONENT_IDS] },
    order: { type: 'integer', minimum: 1, maximum: MAX_DEMO_SECTIONS },
    addressesFindingRef: { type: ['string', 'null'] },
    factKeys: { type: 'array', items: { type: 'string', enum: [...FACT_KEYS] } },
    messagingEmphasis: { type: 'string', enum: [...MESSAGING_EMPHASES] },
  },
  ['componentId', 'order', 'addressesFindingRef', 'factKeys', 'messagingEmphasis'],
);

export const DESIGN_SPEC_JSON_SCHEMA = strObj(
  {
    visualDirection: { type: 'string', enum: [...VISUAL_DIRECTIONS] },
    heroStrategy: { type: 'string', enum: [...HERO_STRATEGIES] },
    headerVariant: { type: 'string', enum: [...HEADER_COMPONENT_IDS] },
    footerVariant: { type: 'string', enum: [...FOOTER_COMPONENT_IDS] },
    primaryCtaIntent: { type: 'string', enum: [...CTA_INTENTS] },
    primaryCtaLabelKey: { type: 'string', enum: [...CTA_LABEL_KEYS] },
    secondaryCtaEnabled: { type: 'boolean' },
    sections: { type: 'array', items: sectionJson },
    mobilePriority: { type: 'array', items: { type: 'string', enum: [...BODY_COMPONENT_IDS] } },
    rationale: { type: 'string' },
  },
  [
    'visualDirection', 'heroStrategy', 'headerVariant', 'footerVariant', 'primaryCtaIntent',
    'primaryCtaLabelKey', 'secondaryCtaEnabled', 'sections', 'mobilePriority', 'rationale',
  ],
);

export const DESIGN_REVIEW_JSON_SCHEMA = strObj(
  {
    decision: { type: 'string', enum: [...REVIEW_DECISIONS] },
    fabricationRisk: { type: 'boolean' },
    evidenceConsistent: { type: 'boolean' },
    ctaHonest: { type: 'boolean' },
    revisionRequiresNewFacts: { type: 'boolean' },
    revisionRequiresNewClaims: { type: 'boolean' },
    revisionRequiresCtaChange: { type: 'boolean' },
    problems: { type: 'array', items: { type: 'string' } },
  },
  ['decision', 'fabricationRisk', 'evidenceConsistent', 'ctaHonest', 'revisionRequiresNewFacts', 'revisionRequiresNewClaims', 'revisionRequiresCtaChange', 'problems'],
);
