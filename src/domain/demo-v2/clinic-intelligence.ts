import { z } from 'zod';
import { SHA256_PATTERN } from './hash.js';

export const supportedDemoV2Languages = ['de', 'en', 'fr', 'he', 'ar'] as const;
export const demoV2LanguageSchema = z.enum(supportedDemoV2Languages);
export const demoV2DirectionSchema = z.enum(['LTR', 'RTL']);

export function expectedDirection(language: string): 'LTR' | 'RTL' {
  return language === 'he' || language === 'ar' ? 'RTL' : 'LTR';
}

export const clinicIntelligencePackageSchema = z.object({
  id: z.string().min(1),
  artifactId: z.string().min(1),
  version: z.number().int().positive(),
  schemaVersion: z.string().min(1),
  status: z.enum(['DRAFT', 'READY', 'STALE', 'BLOCKED']),
  primaryLanguage: demoV2LanguageSchema,
  primaryDirection: demoV2DirectionSchema,
  supportedLanguages: z.array(demoV2LanguageSchema).min(1),
  package: z.record(z.string(), z.unknown()),
  inputFingerprint: z.string().regex(SHA256_PATTERN),
  packageHash: z.string().regex(SHA256_PATTERN),
}).superRefine((value, ctx) => {
  if (value.primaryDirection !== expectedDirection(value.primaryLanguage)) {
    ctx.addIssue({ code: 'custom', path: ['primaryDirection'], message: 'direction does not match primary language' });
  }
  if (!value.supportedLanguages.includes(value.primaryLanguage)) {
    ctx.addIssue({ code: 'custom', path: ['supportedLanguages'], message: 'primary language must be supported' });
  }
  for (const language of value.supportedLanguages) {
    if (value.supportedLanguages.filter((item) => item === language).length !== 1) {
      ctx.addIssue({ code: 'custom', path: ['supportedLanguages'], message: 'languages must be unique' });
      break;
    }
  }
});

export type ClinicIntelligencePackage = z.infer<typeof clinicIntelligencePackageSchema>;
