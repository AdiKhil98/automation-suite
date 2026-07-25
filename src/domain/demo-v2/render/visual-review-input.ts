import { z } from 'zod';
import { demoV2Hash, SHA256_PATTERN } from '../hash.js';
import {
  reviewPackageSchema, reviewScreenshotSetHash, type DemoV2ReviewPackage, type ReviewScreenshot,
} from './review-package.js';
import { VISUAL_SCORE_CATEGORIES, REVISION_OPERATIONS } from './visual-review.js';

/**
 * Assembles the EXACT, minimal reviewer input. The reviewer sees only baseline + final screenshots,
 * the Creative Brief, the ExperiencePlan, the reference family, deterministic validation results,
 * audit findings (when present), a content/asset provenance summary, and the relevant hashes. It
 * never receives the whole repository, source code, secrets, or unrelated evidence.
 *
 * The output of {@link buildVisualReviewInput} is deterministic and hashable: the same render +
 * screenshots + package always fingerprint identically, which is what the exact-fingerprint cache
 * and the fail-closed hash bindings rely on.
 */

export const DEMO_V2_VISUAL_REVIEW_INPUT_VERSION = 'demo-v2-visual-review-input-1';

const hash = z.string().regex(SHA256_PATTERN);

export const visualReviewAuditFindingSchema = z.object({
  findingRef: z.string().min(1),
  category: z.string().min(1),
  summary: z.string().min(1),
  safeForOutreach: z.boolean(),
});
export type VisualReviewAuditFinding = z.infer<typeof visualReviewAuditFindingSchema>;

export const visualReviewProvenanceSchema = z.object({
  /** Every content string is evidence-bound; the reviewer may not invent copy. */
  contentClaimClasses: z.array(z.string().min(1)),
  contentSourceIds: z.array(z.string().min(1)),
  assetSelectionIds: z.array(z.string().min(1)),
  assetRecordHashes: z.array(hash),
  humanApprovedAssetReuse: z.boolean(),
});
export type VisualReviewProvenance = z.infer<typeof visualReviewProvenanceSchema>;

const reviewScreenshotRefSchema = z.object({
  ref: z.string().min(1),
  kind: z.enum(['ORIGINAL', 'FINAL']),
  language: z.string().min(2),
  viewport: z.enum(['DESKTOP', 'TABLET', 'MOBILE']),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fileHash: hash,
});

export const visualReviewInputSchema = z.object({
  inputVersion: z.literal(DEMO_V2_VISUAL_REVIEW_INPUT_VERSION),
  artifactId: z.string().min(1),
  referenceFamily: z.string().min(1),
  primaryLanguage: z.string().min(2),
  supportedLanguages: z.array(z.string().min(2)).min(1),
  baselineScreenshots: z.array(reviewScreenshotRefSchema).min(1),
  finalScreenshots: z.array(reviewScreenshotRefSchema).min(1),
  creativeBrief: z.record(z.string(), z.unknown()),
  experiencePlan: z.record(z.string(), z.unknown()),
  deterministicValidation: reviewPackageSchema.shape.deterministicValidation,
  auditFindings: z.array(visualReviewAuditFindingSchema),
  provenance: visualReviewProvenanceSchema,
  hashes: z.object({
    render: hash,
    screenshotSet: hash,
    reviewPackage: hash,
    creativeBrief: hash,
    experiencePlan: hash,
    componentRegistry: hash,
    referenceLibrary: hash,
    qualityRubric: hash,
  }),
  rubric: z.object({
    categories: z.array(z.string().min(1)).min(1),
    revisionOperations: z.array(z.string().min(1)).min(1),
    decisionVocabulary: z.array(z.string().min(1)).min(1),
  }),
}).superRefine((value, ctx) => {
  const refs = new Set<string>();
  for (const shot of [...value.baselineScreenshots, ...value.finalScreenshots]) {
    if (refs.has(shot.ref)) ctx.addIssue({ code: 'custom', path: ['baselineScreenshots'], message: `duplicate screenshot ref ${shot.ref}` });
    refs.add(shot.ref);
  }
  if (value.baselineScreenshots.some((shot) => shot.kind !== 'ORIGINAL')) {
    ctx.addIssue({ code: 'custom', path: ['baselineScreenshots'], message: 'baseline set must contain only ORIGINAL screenshots' });
  }
  if (value.finalScreenshots.some((shot) => shot.kind !== 'FINAL')) {
    ctx.addIssue({ code: 'custom', path: ['finalScreenshots'], message: 'final set must contain only FINAL screenshots' });
  }
});
export type VisualReviewInput = z.infer<typeof visualReviewInputSchema>;

function screenshotRef(shot: ReviewScreenshot): string {
  return `${shot.kind.toLowerCase()}-${shot.language}-${shot.viewport.toLowerCase()}.png`;
}

export interface VisualReviewInputSources {
  reviewPackage: DemoV2ReviewPackage;
  reviewPackageHash: string;
  auditFindings?: readonly VisualReviewAuditFinding[];
  provenance: VisualReviewProvenance;
}

/**
 * Build the reviewer input from an already-validated review package. Fails closed: a package whose
 * screenshot-set hash does not match its screenshots, or that is missing baseline/final images, is
 * rejected here before any (mock or live) reviewer is constructed.
 */
export function buildVisualReviewInput(sources: VisualReviewInputSources): VisualReviewInput {
  const pkg = reviewPackageSchema.parse(sources.reviewPackage);

  const recomputedSet = reviewScreenshotSetHash(pkg.screenshots);
  if (recomputedSet !== pkg.hashes.screenshotSet) {
    throw new Error('demo_v2_visual_review_input_screenshot_set_mismatch');
  }

  const baselineScreenshots = pkg.screenshots
    .filter((shot) => shot.kind === 'ORIGINAL')
    .map((shot) => ({ ref: screenshotRef(shot), kind: shot.kind, language: shot.language, viewport: shot.viewport, width: shot.width, height: shot.height, fileHash: shot.fileHash }));
  const finalScreenshots = pkg.screenshots
    .filter((shot) => shot.kind === 'FINAL')
    .map((shot) => ({ ref: screenshotRef(shot), kind: shot.kind, language: shot.language, viewport: shot.viewport, width: shot.width, height: shot.height, fileHash: shot.fileHash }));
  if (baselineScreenshots.length === 0) throw new Error('demo_v2_visual_review_input_missing_baseline');
  if (finalScreenshots.length === 0) throw new Error('demo_v2_visual_review_input_missing_final');

  return visualReviewInputSchema.parse({
    inputVersion: DEMO_V2_VISUAL_REVIEW_INPUT_VERSION,
    artifactId: pkg.artifactId,
    referenceFamily: pkg.referenceFamily,
    primaryLanguage: pkg.primaryLanguage,
    supportedLanguages: pkg.supportedLanguages,
    baselineScreenshots,
    finalScreenshots,
    creativeBrief: pkg.creativeBrief,
    experiencePlan: pkg.experiencePlan,
    deterministicValidation: pkg.deterministicValidation,
    auditFindings: [...(sources.auditFindings ?? [])],
    provenance: sources.provenance,
    hashes: {
      render: pkg.hashes.render,
      screenshotSet: pkg.hashes.screenshotSet,
      reviewPackage: sources.reviewPackageHash,
      creativeBrief: pkg.hashes.creativeBrief,
      experiencePlan: pkg.hashes.experiencePlan,
      componentRegistry: pkg.hashes.componentRegistry,
      referenceLibrary: pkg.hashes.referenceLibrary,
      qualityRubric: pkg.hashes.qualityRubric,
    },
    rubric: {
      categories: [...VISUAL_SCORE_CATEGORIES],
      revisionOperations: [...REVISION_OPERATIONS],
      decisionVocabulary: ['APPROVE', 'REVISE', 'REJECT'],
    },
  });
}

/** Deterministic fingerprint of the exact reviewer input — the cache key and the paid-call key. */
export function visualReviewInputFingerprint(input: VisualReviewInput): string {
  return demoV2Hash(input);
}

/** Every screenshot ref the reviewer is allowed to cite (baseline + final). */
export function visualReviewScreenshotRefs(input: VisualReviewInput): string[] {
  return [...input.baselineScreenshots, ...input.finalScreenshots].map((shot) => shot.ref);
}

/**
 * Strict json_schema for the live reviewer's structured OUTPUT. This is the ONLY shape the model may
 * return; provider/model/usage/cost/hash fields are added by the provider, never by the model.
 */
export const VISUAL_REVIEW_OUTPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['overallScore', 'scores', 'blockers', 'findings', 'screenshotRefs', 'permittedRevisionOperations', 'decision'],
  properties: {
    overallScore: { type: 'integer', minimum: 0, maximum: 100 },
    scores: {
      type: 'object',
      additionalProperties: false,
      required: [...VISUAL_SCORE_CATEGORIES],
      properties: Object.fromEntries(VISUAL_SCORE_CATEGORIES.map((category) => [category, { type: 'integer', minimum: 0, maximum: 100 }])),
    },
    blockers: { type: 'array', items: findingJsonSchema() },
    findings: { type: 'array', items: findingJsonSchema() },
    screenshotRefs: { type: 'array', items: { type: 'string' } },
    permittedRevisionOperations: { type: 'array', items: { type: 'string', enum: [...REVISION_OPERATIONS] } },
    decision: { type: 'string', enum: ['APPROVE', 'REVISE', 'REJECT'] },
  },
};

function findingJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['code', 'detail', 'screenshotRef'],
    properties: {
      code: { type: 'string' },
      detail: { type: 'string' },
      screenshotRef: { type: 'string' },
    },
  };
}
