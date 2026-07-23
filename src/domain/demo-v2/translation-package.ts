import { z } from 'zod';
import { demoV2DirectionSchema, demoV2LanguageSchema, expectedDirection } from './clinic-intelligence.js';
import { type PrimaryContentPackage } from './content-package.js';
import { SHA256_PATTERN } from './hash.js';

export const translationRecordSchema = z.object({
  sourceContentItemId: z.string().min(1),
  sourceItemHash: z.string().regex(SHA256_PATTERN),
  translatedText: z.string().min(1).nullable(),
  translatedStructuredValue: z.record(z.string(), z.unknown()).nullable(),
  translationItemHash: z.string().regex(SHA256_PATTERN).nullable(),
  status: z.enum(['MISSING', 'TRANSLATED', 'REVIEWED', 'STALE', 'REJECTED']),
}).superRefine((value, ctx) => {
  const valueCount = Number(value.translatedText !== null) + Number(value.translatedStructuredValue !== null);
  if (value.status === 'MISSING' && (valueCount !== 0 || value.translationItemHash !== null)) {
    ctx.addIssue({ code: 'custom', message: 'missing translation must not contain translated content' });
  }
  if ((value.status === 'TRANSLATED' || value.status === 'REVIEWED')
    && (valueCount !== 1 || value.translationItemHash === null)) {
    ctx.addIssue({ code: 'custom', message: 'translated record requires one value and a hash' });
  }
});

export const translationPackageSchema = z.object({
  id: z.string().min(1),
  artifactId: z.string().min(1),
  sourceContentPackageId: z.string().min(1),
  version: z.number().int().positive(),
  language: demoV2LanguageSchema,
  direction: demoV2DirectionSchema,
  status: z.enum(['DRAFT', 'INCOMPLETE', 'READY_FOR_REVIEW', 'REVIEWED', 'STALE', 'REJECTED']),
  sourceContentHash: z.string().regex(SHA256_PATTERN),
  sourceFingerprint: z.string().regex(SHA256_PATTERN),
  translationHash: z.string().regex(SHA256_PATTERN).nullable(),
  reviewStatus: z.enum(['NOT_REVIEWED', 'APPROVED', 'REJECTED']),
  reviewActorType: z.enum(['MODEL', 'HUMAN', 'SYSTEM']).nullable(),
  reviewActorId: z.string().min(1).nullable(),
  records: z.array(translationRecordSchema),
}).superRefine((value, ctx) => {
  if (value.direction !== expectedDirection(value.language)) {
    ctx.addIssue({ code: 'custom', path: ['direction'], message: 'direction does not match language' });
  }
  if (value.reviewStatus === 'APPROVED'
    && (value.reviewActorType !== 'HUMAN' || !value.reviewActorId || value.status !== 'REVIEWED')) {
    ctx.addIssue({ code: 'custom', path: ['reviewStatus'], message: 'approval requires a human-reviewed package' });
  }
});

export type TranslationPackage = z.infer<typeof translationPackageSchema>;

export function chooseCompleteLanguagePackage(
  primary: PrimaryContentPackage,
  requestedLanguage: string,
  translation: TranslationPackage | undefined,
): { language: string; source: 'PRIMARY' | 'TRANSLATION' } {
  if (requestedLanguage === primary.language) return { language: primary.language, source: 'PRIMARY' };
  const expected = primary.items.filter((item) => item.translatable);
  const complete = translation?.language === requestedLanguage
    && translation.status === 'REVIEWED'
    && translation.reviewStatus === 'APPROVED'
    && translation.reviewActorType === 'HUMAN'
    && translation.sourceContentPackageId === primary.id
    && translation.sourceContentHash === primary.contentHash
    && translation.translationHash !== null
    && translation.records.length === expected.length
    && expected.every((item) => translation.records.some((record) =>
      record.sourceContentItemId === item.id
      && record.sourceItemHash === item.itemHash
      && record.status === 'REVIEWED'
      && record.translationItemHash !== null));
  return complete
    ? { language: requestedLanguage, source: 'TRANSLATION' }
    : { language: primary.language, source: 'PRIMARY' };
}
