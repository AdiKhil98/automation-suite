import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  approvalDecisionSchema, approvalPackageSchema, assertDecisionBindings,
  assertRequiredCategoryScores, computeApprovalPackageHash, isHumanDeploymentApproved,
  screenshotSetHash, screenshotSetSchema, type ApprovalDecision, type ScreenshotSet,
} from '../../src/domain/demo-v2/approval-package.js';
import { assertDemoV2Enabled, assertDemoV2Transition } from '../../src/domain/demo-v2/artifact-lifecycle.js';
import { assetReuseReviewSchema, assetSelectionSchema, isAssetUsable } from '../../src/domain/demo-v2/asset-catalog.js';
import { clinicIntelligencePackageSchema, expectedDirection } from '../../src/domain/demo-v2/clinic-intelligence.js';
import { primaryContentPackageSchema } from '../../src/domain/demo-v2/content-package.js';
import { aggregateBindings, demoV2Hash } from '../../src/domain/demo-v2/hash.js';
import { parseComponentRegistry } from '../../src/domain/demo-v2/manifests/component-registry.js';
import { parseReferenceLibrary } from '../../src/domain/demo-v2/manifests/reference-library.js';
import { chooseCompleteLanguagePackage, translationPackageSchema } from '../../src/domain/demo-v2/translation-package.js';
import { DemoV2FoundationRepository } from '../../src/persistence/repositories/demo-v2-foundation.repo.js';

const h = (letter: string) => letter.repeat(64);

const primary = primaryContentPackageSchema.parse({
  id: 'primary-1', artifactId: 'artifact-1', clinicIntelligencePackageId: 'intel-1',
  clinicIntelligenceHash: h('a'), version: 1, schemaVersion: 'content-v1',
  language: 'de', direction: 'LTR', status: 'READY', sourceFingerprint: h('b'),
  contentHash: h('c'), items: [
    { id: 'item-1', contentKey: 'hero.heading', contentKind: 'HEADING',
      claimClass: 'EVIDENCE_BOUND_DERIVATION', textValue: 'Sorgfältige Zahnmedizin',
      structuredValue: null, translatable: true, position: 0, itemHash: h('d') },
    { id: 'item-2', contentKey: 'contact.phone', contentKind: 'CONTACT',
      claimClass: 'VERBATIM_FACT', textValue: '+49 30 000000', structuredValue: null,
      translatable: false, position: 1, itemHash: h('e') },
  ],
});

function reviewedTranslation(over: Record<string, unknown> = {}) {
  return translationPackageSchema.parse({
    id: 'translation-en-1', artifactId: 'artifact-1', sourceContentPackageId: primary.id,
    version: 1, language: 'en', direction: 'LTR', status: 'REVIEWED',
    sourceContentHash: primary.contentHash, sourceFingerprint: h('f'), translationHash: h('1'),
    reviewStatus: 'APPROVED', reviewActorType: 'HUMAN', reviewActorId: 'reviewer-1',
    records: [{ sourceContentItemId: 'item-1', sourceItemHash: h('d'),
      translatedText: 'Careful dentistry', translatedStructuredValue: null,
      translationItemHash: h('2'), status: 'REVIEWED' }],
    ...over,
  });
}

function screenshots(): ScreenshotSet {
  const entries: ScreenshotSet['entries'] = [
    ...(['DESKTOP', 'MOBILE'] as const).map((viewport) => ({
      kind: 'ORIGINAL' as const, language: 'de', viewport, sectionKey: null,
      width: viewport === 'DESKTOP' ? 1440 : 390, height: viewport === 'DESKTOP' ? 900 : 844,
      fileHash: demoV2Hash(`original-${viewport}`),
    })),
    ...['de', 'en', 'fr', 'he', 'ar'].flatMap((language) =>
      (['DESKTOP', 'MOBILE'] as const).map((viewport) => ({
        kind: 'FINAL' as const, language, viewport, sectionKey: null,
        width: viewport === 'DESKTOP' ? 1440 : 390, height: viewport === 'DESKTOP' ? 900 : 844,
        fileHash: demoV2Hash(`${language}-${viewport}`),
      }))),
    { kind: 'SECTION', language: 'de', viewport: 'DESKTOP', sectionKey: 'hero',
      width: 1440, height: 700, fileHash: demoV2Hash('section-hero') },
  ];
  return { primaryLanguage: 'de', supportedLanguages: ['de', 'en', 'fr', 'he', 'ar'],
    requiredSectionKeys: ['hero'], rendererVersion: 'renderer-v1', entries };
}

function approval() {
  const bindings = {
    artifactId: 'artifact-1', clinicIntelligencePackageId: 'intel-1',
    primaryContentPackageId: 'primary-1', assetCatalogId: 'catalog-1',
    creativeBriefId: 'brief-1', experiencePlanId: 'plan-1', schemaVersion: 'approval-v1',
    intelligenceHash: h('a'), primaryContentHash: h('b'),
    translationSetHash: h('c'), assetCatalogHash: h('d'), assetSelectionSetHash: h('e'),
    creativeBriefHash: h('f'), experiencePlanHash: h('1'),
    componentRegistryVersion: 'registry-v1', componentRegistryHash: h('2'),
    referenceLibraryVersion: 'references-v1', referenceLibraryHash: h('3'),
    renderHash: h('4'), screenshotSetHash: screenshotSetHash(screenshots()),
    qualityRubricVersion: 'quality-v1', qualityRubricHash: h('5'), visualReviewSetHash: h('6'),
  };
  return approvalPackageSchema.parse({
    id: 'approval-1', ...bindings, approvalPackageHash: computeApprovalPackageHash(bindings),
  });
}

function decision(kind: ApprovalDecision['decision'], actorType: ApprovalDecision['actorType']): ApprovalDecision {
  const packageValue = approval();
  return approvalDecisionSchema.parse({
    decision: kind, actorType, actorId: 'actor-1',
    reviewCycle: kind.startsWith('AUTO_') ? 1 : null,
    score: kind === 'AUTO_REVIEW_PASSED' ? 91 : null,
    blockerCount: kind === 'AUTO_REVIEW_PASSED' ? 0 : null,
    categoryScores: kind === 'AUTO_REVIEW_PASSED'
      ? { visualHierarchy: 82, mobile: 88, evidence: 95 } : {},
    boundApprovalPackageHash: packageValue.approvalPackageHash,
    boundVisualReviewSetHash: packageValue.visualReviewSetHash,
    boundQualityRubricHash: packageValue.qualityRubricHash,
  });
}

describe('Demo Engine V2 Milestone 1 foundation', () => {
  it('defaults to a separate, explicitly gated lifecycle', () => {
    expect(() => assertDemoV2Enabled({ DEMO_ENGINE_VERSION: 'v1', DEMO_V2_ENABLED: false }))
      .toThrow('demo_v2_disabled');
    expect(() => assertDemoV2Enabled({ DEMO_ENGINE_VERSION: 'v2', DEMO_V2_ENABLED: true }))
      .not.toThrow();
    expect(() => assertDemoV2Transition('INTELLIGENCE_PENDING', 'INTELLIGENCE_READY')).not.toThrow();
    expect(() => assertDemoV2Transition('INTELLIGENCE_PENDING', 'HUMAN_APPROVED'))
      .toThrow('invalid_demo_v2_transition');
  });

  it('supports DE/EN/FR/HE/AR with exact RTL metadata and long text', () => {
    for (const language of ['de', 'en', 'fr', 'he', 'ar'] as const) {
      const parsed = clinicIntelligencePackageSchema.parse({
        id: `intel-${language}`, artifactId: 'artifact-1', version: 1, schemaVersion: 'intel-v1',
        status: 'READY', primaryLanguage: language, primaryDirection: expectedDirection(language),
        supportedLanguages: [language], package: { description: 'é'.repeat(4_000) },
        inputFingerprint: h('a'), packageHash: h('b'),
      });
      expect(parsed.primaryDirection).toBe(language === 'he' || language === 'ar' ? 'RTL' : 'LTR');
    }
    expect(() => clinicIntelligencePackageSchema.parse({
      id: 'bad', artifactId: 'artifact', version: 1, schemaVersion: 'v1', status: 'READY',
      primaryLanguage: 'he', primaryDirection: 'LTR', supportedLanguages: ['he'],
      package: {}, inputFingerprint: h('a'), packageHash: h('b'),
    })).toThrow();
  });

  it('uses complete human-approved translations or falls back wholly to primary', () => {
    expect(chooseCompleteLanguagePackage(primary, 'en', reviewedTranslation())).toEqual({
      language: 'en', source: 'TRANSLATION',
    });
    expect(chooseCompleteLanguagePackage(primary, 'en', undefined)).toEqual({
      language: 'de', source: 'PRIMARY',
    });
    const stale = reviewedTranslation({ status: 'STALE', reviewStatus: 'NOT_REVIEWED',
      reviewActorType: 'MODEL', reviewActorId: 'model-1' });
    expect(chooseCompleteLanguagePackage(primary, 'en', stale)).toEqual({
      language: 'de', source: 'PRIMARY',
    });
  });

  it('prohibits model/system translation approval', () => {
    expect(() => reviewedTranslation({ reviewActorType: 'MODEL' })).toThrow();
    expect(() => reviewedTranslation({ reviewActorType: 'SYSTEM' })).toThrow();
  });

  it('separates selection from exact human asset-reuse approval', () => {
    const selection = assetSelectionSchema.parse({
      id: 'selection-1', assetId: 'asset-1', status: 'SELECTED',
      boundAssetRecordHash: h('a'), selectionHash: h('b'),
    });
    const review = assetReuseReviewSchema.parse({
      id: 'review-1', assetSelectionId: selection.id, decision: 'APPROVED_CONCEPT_USE',
      actorType: 'HUMAN', actorId: 'reviewer-1', boundAssetRecordHash: h('a'),
      boundSelectionHash: h('b'), reviewHash: h('c'),
    });
    expect(isAssetUsable(selection, review)).toBe(true);
    expect(isAssetUsable({ ...selection, status: 'REUSE_REVIEW_REQUIRED' }, review)).toBe(false);
    expect(isAssetUsable({ ...selection, selectionHash: h('d') }, review)).toBe(false);
    expect(isAssetUsable(selection, review, h('d'))).toBe(false);
    expect(() => assetReuseReviewSchema.parse({ ...review, actorType: 'MODEL' })).toThrow();
    expect(() => assetReuseReviewSchema.parse({ ...review, decision: 'REJECTED', actorType: 'SYSTEM' })).toThrow();
  });

  it('hashes canonical bindings deterministically and order-independently', () => {
    expect(demoV2Hash({ b: 2, a: 1 })).toBe(demoV2Hash({ a: 1, b: 2 }));
    expect(aggregateBindings([{ id: 'b', hash: h('b') }, { id: 'a', hash: h('a') }]))
      .toBe(aggregateBindings([{ id: 'a', hash: h('a') }, { id: 'b', hash: h('b') }]));
    expect(aggregateBindings([{ id: 'a', hash: h('a') }]))
      .not.toBe(aggregateBindings([{ id: 'a', hash: h('b') }]));
  });

  it('requires original/final desktop+mobile, every language, sections and renderer binding', () => {
    const valid = screenshots();
    expect(screenshotSetSchema.parse(valid)).toEqual(valid);
    expect(screenshotSetHash(valid)).toMatch(/^[a-f0-9]{64}$/);
    expect(() => screenshotSetSchema.parse({
      ...valid, entries: valid.entries.filter((entry) =>
        !(entry.kind === 'FINAL' && entry.language === 'he' && entry.viewport === 'MOBILE')),
    })).toThrow(/missing he mobile/);
    expect(() => screenshotSetSchema.parse({
      ...valid, entries: valid.entries.filter((entry) => entry.kind !== 'ORIGINAL'),
    })).toThrow(/missing original/);
  });

  it('binds auto review to rubric and visual set and enforces every required category', () => {
    const packageValue = approval();
    const auto = decision('AUTO_REVIEW_PASSED', 'MODEL');
    expect(() => assertDecisionBindings(auto, packageValue)).not.toThrow();
    expect(() => assertRequiredCategoryScores(auto, ['visualHierarchy', 'mobile', 'evidence'])).not.toThrow();
    expect(() => assertRequiredCategoryScores(auto, ['visualHierarchy', 'accessibility']))
      .toThrow('demo_v2_required_category_threshold_not_met');
    const optionalLow = approvalDecisionSchema.parse({ ...auto, categoryScores: { mobile: 88, optional: 20 } });
    expect(() => assertRequiredCategoryScores(optionalLow, ['mobile'])).not.toThrow();
    expect(() => assertRequiredCategoryScores(optionalLow, ['optional']))
      .toThrow('demo_v2_required_category_threshold_not_met');
    expect(() => assertDecisionBindings({ ...auto, boundQualityRubricHash: h('9') }, packageValue))
      .toThrow('demo_v2_approval_binding_mismatch');
  });

  it('never treats automatic review or a model actor as deployment approval', () => {
    const packageValue = approval();
    const auto = decision('AUTO_REVIEW_PASSED', 'MODEL');
    const human = decision('HUMAN_APPROVED', 'HUMAN');
    const categories = ['visualHierarchy', 'mobile', 'evidence'];
    expect(isHumanDeploymentApproved(packageValue, [auto], false, categories)).toBe(false);
    expect(isHumanDeploymentApproved(packageValue, [auto, human], false, categories)).toBe(true);
    expect(isHumanDeploymentApproved(packageValue, [auto, human], true, categories)).toBe(false);
    expect(() => approvalDecisionSchema.parse({ ...human, actorType: 'MODEL' })).toThrow();
  });

  it('validates local manifests without network access', () => {
    const components = JSON.parse(readFileSync(new URL('../../design-library/component-registry.v1.json', import.meta.url), 'utf8'));
    const references = JSON.parse(readFileSync(new URL('../../design-library/reference-library.v1.json', import.meta.url), 'utf8'));
    expect(parseComponentRegistry(components).hash).toMatch(/^[a-f0-9]{64}$/);
    expect(parseReferenceLibrary(references).manifest.references[0]?.allowedUse).toBe('INSPIRATION_ONLY');
  });

  it('repository rejects incomplete screenshot and package bindings before persistence', async () => {
    let inserts = 0;
    const db = { insert: () => { inserts += 1; throw new Error('unexpected_insert'); } };
    const repository = new DemoV2FoundationRepository(db as never);
    const packageValue = approval();
    await expect(repository.createApprovalPackage({
      ...packageValue,
      screenshotSetHash: h('9'),
      clinicIntelligencePackageId: 'intel-1',
      primaryContentPackageId: 'primary-1',
      assetCatalogId: 'catalog-1',
      creativeBriefId: 'brief-1',
      experiencePlanId: 'plan-1',
      schemaVersion: 'approval-v1',
    }, screenshots())).rejects.toThrow('demo_v2_screenshot_set_hash_mismatch');
    await expect(repository.createApprovalPackage({
      ...packageValue,
      approvalPackageHash: h('9'),
      clinicIntelligencePackageId: 'intel-1',
      primaryContentPackageId: 'primary-1',
      assetCatalogId: 'catalog-1',
      creativeBriefId: 'brief-1',
      experiencePlanId: 'plan-1',
      schemaVersion: 'approval-v1',
    }, screenshots())).rejects.toThrow('demo_v2_approval_package_hash_mismatch');
    expect(inserts).toBe(0);
  });
});
