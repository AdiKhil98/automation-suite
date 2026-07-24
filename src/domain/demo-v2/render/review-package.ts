import { z } from 'zod';
import { demoV2Hash, SHA256_PATTERN } from '../hash.js';
import { DEMO_V2_QUALITY_RUBRIC_VERSION } from './quality-checks.js';
import { DEMO_V2_RENDERER_VERSION } from './renderer.js';

/**
 * The operator review package. It is assembled and written locally only — nothing here is
 * uploaded, deployed, or emailed, and it never marks an artifact deployment eligible.
 */

const hash = z.string().regex(SHA256_PATTERN);

export const VIEWPORT_NAMES = ['DESKTOP', 'TABLET', 'MOBILE'] as const;

export const reviewScreenshotSchema = z.object({
  kind: z.enum(['ORIGINAL', 'FINAL']),
  language: z.string().min(2),
  viewport: z.enum(VIEWPORT_NAMES),
  path: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fileHash: hash,
});
export type ReviewScreenshot = z.infer<typeof reviewScreenshotSchema>;

export const reviewPackageSchema = z.object({
  schemaVersion: z.literal('demo-v2-review-package-1'),
  artifactId: z.string().min(1),
  referenceFamily: z.string().min(1),
  rendererVersion: z.literal(DEMO_V2_RENDERER_VERSION),
  qualityRubricVersion: z.literal(DEMO_V2_QUALITY_RUBRIC_VERSION),
  primaryLanguage: z.string().min(2),
  supportedLanguages: z.array(z.string().min(2)).min(1),
  creativeBrief: z.record(z.string(), z.unknown()),
  experiencePlan: z.record(z.string(), z.unknown()),
  hashes: z.object({
    intelligence: hash,
    content: hash,
    translation: hash.nullable(),
    assets: z.array(hash),
    creativeBrief: hash,
    experiencePlan: hash,
    componentRegistry: hash,
    referenceLibrary: hash,
    render: hash,
    screenshotSet: hash,
    qualityRubric: hash,
  }),
  screenshots: z.array(reviewScreenshotSchema).min(1),
  deterministicValidation: z.object({
    structurallyEligible: z.boolean(),
    blockers: z.array(z.object({ code: z.string(), detail: z.string(), language: z.string() })),
    findings: z.array(z.object({ code: z.string(), detail: z.string(), language: z.string() })),
  }),
  /** Explicit: this package never authorises deployment or human approval. */
  deploymentEligible: z.literal(false),
}).superRefine((value, ctx) => {
  for (const language of value.supportedLanguages) {
    for (const viewport of VIEWPORT_NAMES) {
      if (!value.screenshots.some((shot) =>
        shot.kind === 'FINAL' && shot.language === language && shot.viewport === viewport)) {
        ctx.addIssue({ code: 'custom', path: ['screenshots'], message: `missing FINAL ${language} ${viewport}` });
      }
    }
  }
  for (const viewport of VIEWPORT_NAMES) {
    if (!value.screenshots.some((shot) =>
      shot.kind === 'ORIGINAL' && shot.viewport === viewport)) {
      ctx.addIssue({ code: 'custom', path: ['screenshots'], message: `missing ORIGINAL ${viewport}` });
    }
  }
});
export type DemoV2ReviewPackage = z.infer<typeof reviewPackageSchema>;

/** Deterministic hash over the complete screenshot set (kind, language, viewport, bytes). */
export function reviewScreenshotSetHash(screenshots: readonly ReviewScreenshot[]): string {
  return demoV2Hash([...screenshots]
    .map((shot) => ({
      kind: shot.kind, language: shot.language, viewport: shot.viewport,
      width: shot.width, height: shot.height, fileHash: shot.fileHash,
    }))
    .sort((a, b) => `${a.kind}:${a.language}:${a.viewport}`.localeCompare(`${b.kind}:${b.language}:${b.viewport}`)));
}

export function reviewPackageHash(pkg: DemoV2ReviewPackage): string {
  return demoV2Hash({
    artifactId: pkg.artifactId,
    referenceFamily: pkg.referenceFamily,
    rendererVersion: pkg.rendererVersion,
    hashes: pkg.hashes,
    screenshots: [...pkg.screenshots].map((shot) => shot.fileHash).sort(),
    deterministicValidation: pkg.deterministicValidation.structurallyEligible,
  });
}
