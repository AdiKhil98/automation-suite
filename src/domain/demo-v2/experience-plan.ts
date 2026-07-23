import { z } from 'zod';
import { demoV2DirectionSchema, demoV2LanguageSchema, expectedDirection } from './clinic-intelligence.js';
import { SHA256_PATTERN } from './hash.js';

export const experiencePlanSchema = z.object({
  id: z.string().min(1),
  artifactId: z.string().min(1),
  creativeBriefId: z.string().min(1),
  primaryContentPackageId: z.string().min(1),
  version: z.number().int().positive(),
  schemaVersion: z.string().min(1),
  status: z.enum(['DRAFT', 'VALIDATED', 'STALE', 'REJECTED']),
  primaryLanguage: demoV2LanguageSchema,
  primaryDirection: demoV2DirectionSchema,
  supportedLanguages: z.array(demoV2LanguageSchema).min(1),
  componentRegistryVersion: z.string().min(1),
  componentRegistryHash: z.string().regex(SHA256_PATTERN),
  referenceLibraryVersion: z.string().min(1),
  referenceLibraryHash: z.string().regex(SHA256_PATTERN),
  plan: z.record(z.string(), z.unknown()),
  inputFingerprint: z.string().regex(SHA256_PATTERN),
  planHash: z.string().regex(SHA256_PATTERN),
}).superRefine((value, ctx) => {
  if (value.primaryDirection !== expectedDirection(value.primaryLanguage)) {
    ctx.addIssue({ code: 'custom', path: ['primaryDirection'], message: 'direction does not match language' });
  }
});
