import { z } from 'zod';
import { demoV2DirectionSchema, demoV2LanguageSchema, expectedDirection } from './clinic-intelligence.js';
import { SHA256_PATTERN } from './hash.js';

export const contentItemSchema = z.object({
  id: z.string().min(1),
  contentKey: z.string().min(1),
  contentKind: z.enum([
    'LABEL', 'NAV_LABEL', 'HEADING', 'BODY', 'CTA_LABEL', 'SERVICE_NAME',
    'FAQ_QUESTION', 'FAQ_ANSWER', 'ALT_TEXT', 'CONTACT', 'HOURS', 'LEGAL', 'STRUCTURED',
  ]),
  claimClass: z.enum(['VERBATIM_FACT', 'EVIDENCE_BOUND_DERIVATION', 'UI_LABEL', 'LEGAL_DISCLOSURE']),
  textValue: z.string().min(1).nullable(),
  structuredValue: z.record(z.string(), z.unknown()).nullable(),
  translatable: z.boolean(),
  position: z.number().int().nonnegative(),
  itemHash: z.string().regex(SHA256_PATTERN),
}).superRefine((value, ctx) => {
  if ((value.textValue === null) === (value.structuredValue === null)) {
    ctx.addIssue({ code: 'custom', message: 'exactly one content value is required' });
  }
  if (value.textValue && /<[^>]+>/.test(value.textValue)) {
    ctx.addIssue({ code: 'custom', path: ['textValue'], message: 'HTML is prohibited' });
  }
});

export const primaryContentPackageSchema = z.object({
  id: z.string().min(1),
  artifactId: z.string().min(1),
  clinicIntelligencePackageId: z.string().min(1),
  clinicIntelligenceHash: z.string().regex(SHA256_PATTERN),
  version: z.number().int().positive(),
  schemaVersion: z.string().min(1),
  language: demoV2LanguageSchema,
  direction: demoV2DirectionSchema,
  status: z.enum(['DRAFT', 'READY', 'STALE', 'REJECTED']),
  sourceFingerprint: z.string().regex(SHA256_PATTERN),
  contentHash: z.string().regex(SHA256_PATTERN),
  items: z.array(contentItemSchema).min(1),
}).superRefine((value, ctx) => {
  if (value.direction !== expectedDirection(value.language)) {
    ctx.addIssue({ code: 'custom', path: ['direction'], message: 'direction does not match language' });
  }
  const keys = value.items.map((item) => item.contentKey);
  if (new Set(keys).size !== keys.length) {
    ctx.addIssue({ code: 'custom', path: ['items'], message: 'content keys must be unique' });
  }
});

export type PrimaryContentPackage = z.infer<typeof primaryContentPackageSchema>;
