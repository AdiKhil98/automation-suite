import { createHash } from 'node:crypto';
import {
  reviewPackageSchema, reviewScreenshotSetHash, reviewPackageHash,
  type DemoV2ReviewPackage, type ReviewScreenshot,
} from '../../../src/domain/demo-v2/render/review-package.js';
import { DEMO_V2_RENDERER_VERSION } from '../../../src/domain/demo-v2/render/renderer.js';
import { DEMO_V2_QUALITY_RUBRIC_VERSION } from '../../../src/domain/demo-v2/render/quality-checks.js';
import { experiencePlanDataSchema, type ExperiencePlanData } from '../../../src/domain/demo-v2/orchestration-types.js';

/**
 * A fully fictional, schema-valid review package for the Milestone 3B2B1 visual-review tests. No
 * real clinic, no real person, no network, no browser: every value here is invented and every hash
 * is computed deterministically from a seed.
 */

export function h(seed: string): string {
  return createHash('sha256').update(`demo-v2-visual-review-fixture:${seed}`).digest('hex');
}

const VIEWPORTS = ['DESKTOP', 'TABLET', 'MOBILE'] as const;
const SIZES: Record<(typeof VIEWPORTS)[number], { width: number; height: number }> = {
  DESKTOP: { width: 1440, height: 3200 },
  TABLET: { width: 834, height: 3600 },
  MOBILE: { width: 390, height: 4200 },
};

function screenshots(): ReviewScreenshot[] {
  const shots: ReviewScreenshot[] = [];
  for (const kind of ['ORIGINAL', 'FINAL'] as const) {
    for (const viewport of VIEWPORTS) {
      shots.push({
        kind, language: 'de', viewport, path: `screenshots/${kind.toLowerCase()}-de-${viewport.toLowerCase()}.png`,
        width: SIZES[viewport].width, height: SIZES[viewport].height,
        fileHash: h(`shot:${kind}:${viewport}`),
      });
    }
  }
  return shots;
}

export function fixtureExperiencePlan(): ExperiencePlanData {
  const section = (order: number, family: string, variant: string) => ({
    order, sectionPurpose: `purpose-${family}`, conversionRole: 'SUPPORT', componentFamily: family,
    componentVariant: variant, requiredContentKeys: [`content.${family}.heading`], selectedClaimSourceIds: [`fact.${family}`],
    selectedAssetCategories: ['clinic'], proposedAssetSelectionIds: [`asset-${family}`], visualTreatment: 'editorial',
    motionPreset: 'NONE' as const, desktopBehavior: 'static', mobileBehavior: 'stacked',
    accessibilityRequirements: ['focus-visible'], supportedLanguages: ['de' as const], auditFindingAddressed: null,
    fallbackBehavior: 'text', justification: `fictional section ${family}`,
  });
  return experiencePlanDataSchema.parse({
    sections: [
      section(1, 'hero', 'editorial'),
      section(2, 'services', 'list'),
      section(3, 'story', 'narrative'),
      section(4, 'appointment-actions', 'persistent'),
      section(5, 'faq', 'accordion'),
    ],
    visibleEnglishSwitcher: true,
    mobileAppointmentPersistent: true,
    selectedReferenceFamily: 'premium-dental-editorial',
    componentRegistryHash: h('component-registry'),
    referenceLibraryHash: h('reference-library'),
    inputFingerprint: h('plan-input'),
  });
}

export function buildFixtureReviewPackage(overrides: Partial<DemoV2ReviewPackage> = {}): DemoV2ReviewPackage {
  const shots = screenshots();
  const base = {
    schemaVersion: 'demo-v2-review-package-1' as const,
    artifactId: 'demo-v2-fixture-artifact',
    referenceFamily: 'premium-dental-editorial',
    rendererVersion: DEMO_V2_RENDERER_VERSION,
    qualityRubricVersion: DEMO_V2_QUALITY_RUBRIC_VERSION,
    primaryLanguage: 'de',
    supportedLanguages: ['de'],
    creativeBrief: { positioning: 'a fictional premium dental clinic', coreMessage: 'calm, precise care' },
    experiencePlan: fixtureExperiencePlan() as unknown as Record<string, unknown>,
    hashes: {
      intelligence: h('intelligence'),
      content: h('content'),
      translation: null,
      assets: [h('asset-a'), h('asset-b')],
      creativeBrief: h('creative-brief'),
      experiencePlan: h('experience-plan'),
      componentRegistry: h('component-registry'),
      referenceLibrary: h('reference-library'),
      render: h('render'),
      screenshotSet: reviewScreenshotSetHash(shots),
      qualityRubric: h('quality-rubric'),
    },
    screenshots: shots,
    deterministicValidation: {
      structurallyEligible: true,
      blockers: [],
      findings: [{ code: 'contrast_advisory', detail: 'A fictional non-blocking note.', language: 'de' }],
    },
    deploymentEligible: false as const,
  };
  return reviewPackageSchema.parse({ ...base, ...overrides });
}

export function fixtureReviewPackageHash(pkg: DemoV2ReviewPackage): string {
  return reviewPackageHash(pkg);
}
