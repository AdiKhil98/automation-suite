import { z } from 'zod';
import { demoV2Hash, SHA256_PATTERN } from './hash.js';

const hashSchema = z.string().regex(SHA256_PATTERN);
const actorSchema = z.enum(['MODEL', 'HUMAN', 'SYSTEM']);

export const screenshotEntrySchema = z.object({
  kind: z.enum(['ORIGINAL', 'FINAL', 'SECTION']),
  language: z.string().min(2).nullable(),
  viewport: z.enum(['DESKTOP', 'MOBILE']),
  sectionKey: z.string().min(1).nullable(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fileHash: hashSchema,
});

export const screenshotSetSchema = z.object({
  primaryLanguage: z.string().min(2),
  supportedLanguages: z.array(z.string().min(2)).min(1),
  requiredSectionKeys: z.array(z.string().min(1)).min(1),
  rendererVersion: z.string().min(1),
  entries: z.array(screenshotEntrySchema).min(1),
}).superRefine((value, ctx) => {
  if (!value.supportedLanguages.includes(value.primaryLanguage)
    || new Set(value.supportedLanguages).size !== value.supportedLanguages.length) {
    ctx.addIssue({ code: 'custom', path: ['supportedLanguages'], message: 'supported languages must be unique and include primary' });
  }
  const has = (kind: 'ORIGINAL' | 'FINAL', language: string | null, viewport: 'DESKTOP' | 'MOBILE') =>
    value.entries.some((entry) => entry.kind === kind && entry.language === language && entry.viewport === viewport);
  for (const viewport of ['DESKTOP', 'MOBILE'] as const) {
    if (!has('ORIGINAL', value.primaryLanguage, viewport)) {
      ctx.addIssue({ code: 'custom', path: ['entries'], message: `missing original ${viewport.toLowerCase()}` });
    }
  }
  for (const language of value.supportedLanguages) {
    for (const viewport of ['DESKTOP', 'MOBILE'] as const) {
      if (!has('FINAL', language, viewport)) {
        ctx.addIssue({ code: 'custom', path: ['entries'], message: `missing ${language} ${viewport.toLowerCase()}` });
      }
    }
  }
  for (const sectionKey of value.requiredSectionKeys) {
    if (!value.entries.some((entry) => entry.kind === 'SECTION' && entry.sectionKey === sectionKey)) {
      ctx.addIssue({ code: 'custom', path: ['entries'], message: `missing section ${sectionKey}` });
    }
  }
});

export type ScreenshotSet = z.infer<typeof screenshotSetSchema>;

export function screenshotSetHash(input: ScreenshotSet): string {
  const parsed = screenshotSetSchema.parse(input);
  return demoV2Hash({
    rendererVersion: parsed.rendererVersion,
    primaryLanguage: parsed.primaryLanguage,
    supportedLanguages: [...parsed.supportedLanguages].sort(),
    requiredSectionKeys: [...parsed.requiredSectionKeys].sort(),
    entries: [...parsed.entries].sort((a, b) =>
      `${a.kind}:${a.language ?? ''}:${a.viewport}:${a.sectionKey ?? ''}`
        .localeCompare(`${b.kind}:${b.language ?? ''}:${b.viewport}:${b.sectionKey ?? ''}`)),
  });
}

export const approvalPackageSchema = z.object({
  id: z.string().min(1),
  artifactId: z.string().min(1),
  clinicIntelligencePackageId: z.string().min(1),
  primaryContentPackageId: z.string().min(1),
  assetCatalogId: z.string().min(1),
  creativeBriefId: z.string().min(1),
  experiencePlanId: z.string().min(1),
  schemaVersion: z.string().min(1),
  approvalPackageHash: hashSchema,
  intelligenceHash: hashSchema,
  primaryContentHash: hashSchema,
  translationSetHash: hashSchema,
  assetCatalogHash: hashSchema,
  assetSelectionSetHash: hashSchema,
  creativeBriefHash: hashSchema,
  experiencePlanHash: hashSchema,
  componentRegistryVersion: z.string().min(1),
  componentRegistryHash: hashSchema,
  referenceLibraryVersion: z.string().min(1),
  referenceLibraryHash: hashSchema,
  renderHash: hashSchema,
  screenshotSetHash: hashSchema,
  qualityRubricVersion: z.string().min(1),
  qualityRubricHash: hashSchema,
  visualReviewSetHash: hashSchema,
});

export type ApprovalPackage = z.infer<typeof approvalPackageSchema>;

export function computeApprovalPackageHash(
  approval: Omit<ApprovalPackage, 'id' | 'approvalPackageHash'>,
): string {
  return demoV2Hash(approval);
}

export const approvalDecisionSchema = z.object({
  decision: z.enum(['AUTO_REVIEW_PASSED', 'AUTO_REVIEW_FAILED', 'HUMAN_APPROVED', 'HUMAN_REJECTED']),
  actorType: actorSchema,
  actorId: z.string().min(1),
  reviewCycle: z.number().int().min(1).max(3).nullable(),
  score: z.number().min(0).max(100).nullable(),
  blockerCount: z.number().int().nonnegative().nullable(),
  categoryScores: z.record(z.string().min(1), z.number().min(0).max(100)),
  boundApprovalPackageHash: hashSchema,
  boundVisualReviewSetHash: hashSchema,
  boundQualityRubricHash: hashSchema,
}).superRefine((value, ctx) => {
  if (value.decision.startsWith('HUMAN_') && value.actorType !== 'HUMAN') {
    ctx.addIssue({ code: 'custom', path: ['actorType'], message: 'human decision requires human actor' });
  }
  if (value.decision === 'AUTO_REVIEW_PASSED') {
    if ((value.actorType !== 'MODEL' && value.actorType !== 'SYSTEM')
      || value.score === null || value.score < 85 || value.blockerCount !== 0
      || Object.keys(value.categoryScores).length === 0) {
      ctx.addIssue({ code: 'custom', path: ['decision'], message: 'automatic review thresholds not met' });
    }
  }
});

export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

export function assertRequiredCategoryScores(
  decision: ApprovalDecision,
  requiredCategories: readonly string[],
): void {
  if (decision.decision !== 'AUTO_REVIEW_PASSED') return;
  if (requiredCategories.length === 0
    || requiredCategories.some((category) => (decision.categoryScores[category] ?? -1) < 70)) {
    throw new Error('demo_v2_required_category_threshold_not_met');
  }
}

export function assertDecisionBindings(decision: ApprovalDecision, approval: ApprovalPackage): void {
  if (decision.boundApprovalPackageHash !== approval.approvalPackageHash
    || decision.boundVisualReviewSetHash !== approval.visualReviewSetHash
    || decision.boundQualityRubricHash !== approval.qualityRubricHash) {
    throw new Error('demo_v2_approval_binding_mismatch');
  }
}

export function isHumanDeploymentApproved(
  approval: ApprovalPackage,
  decisions: readonly ApprovalDecision[],
  invalidated: boolean,
  requiredCategories: readonly string[],
): boolean {
  if (invalidated) return false;
  return decisions.some((decision) => {
    try {
      assertDecisionBindings(decision, approval);
      assertRequiredCategoryScores(decision, requiredCategories);
      return decision.decision === 'AUTO_REVIEW_PASSED';
    } catch {
      return false;
    }
  }) && decisions.some((decision) => {
    try {
      assertDecisionBindings(decision, approval);
      return decision.decision === 'HUMAN_APPROVED' && decision.actorType === 'HUMAN';
    } catch {
      return false;
    }
  });
}
