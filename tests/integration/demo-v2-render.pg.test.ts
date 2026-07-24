import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { parseComponentRegistry } from '../../src/domain/demo-v2/manifests/component-registry.js';
import { parseReferenceLibrary } from '../../src/domain/demo-v2/manifests/reference-library.js';
import { renderDemoV2 } from '../../src/domain/demo-v2/render/renderer.js';
import { runQualityChecks } from '../../src/domain/demo-v2/render/quality-checks.js';
import { reviewScreenshotSetHash } from '../../src/domain/demo-v2/render/review-package.js';
import { demoV2Hash } from '../../src/domain/demo-v2/hash.js';
import { buildAcceptanceFixture, germanClinicFixtureInput } from '../../src/fixtures/demo-v2-render-fixture.js';
import { orchestrateDemoV2Fixture } from '../../src/domain/demo-v2/orchestration-service.js';
import { type DbHandle } from '../../src/persistence/db.js';
import { DemoV2UnitOfWork } from '../../src/persistence/demo-v2-unit-of-work.js';
import {
  demoDecisions, demoV2Artifacts, demoV2ExperiencePlans, demoV2RenderVersions,
  demoV2ReviewPackages, demoV2Screenshots, leadFacts, leads,
} from '../../src/persistence/schema.js';
import { requireIntegrationTestDatabase } from '../support/test-database.js';

const testDatabase = requireIntegrationTestDatabase();
const component = parseComponentRegistry(JSON.parse(readFileSync('design-library/component-registry.v1.json', 'utf8')) as unknown);
const reference = parseReferenceLibrary(JSON.parse(readFileSync('design-library/reference-library.v1.json', 'utf8')) as unknown);
const manifests = {
  componentVersion: component.manifest.version, componentHash: component.hash,
  referenceVersion: reference.manifest.version, referenceHash: reference.hash,
};

const HASH = 'a'.repeat(64);
function fakeHash(seed: string): string {
  return demoV2Hash(seed);
}

const shot = (kind: 'ORIGINAL' | 'FINAL', language: string, viewport: 'DESKTOP' | 'TABLET' | 'MOBILE', seed: string) => ({
  kind, language, viewport, width: 1440, height: 1000, fileHash: fakeHash(seed), location: `screenshots/${kind}-${language}-${viewport}.png`,
});

describe('Demo V2 render persistence (PostgreSQL)', () => {
  let handle: DbHandle;
  beforeEach(async () => { handle ??= testDatabase.createHandle(); await testDatabase.truncate(handle.db); });
  afterAll(async () => { if (handle) await handle.pool.end(); });

  async function seedArtifactAndRender() {
    const leadId = randomUUID();
    const decisionId = randomUUID();
    const artifactId = randomUUID();
    await handle.db.insert(leads).values({ id: leadId, status: 'DEMO_READY' });
    await handle.db.insert(demoDecisions).values({
      id: decisionId, leadId, decision: 'BUILD_DEMO', outcome: 'BUILD', reason: 'fixture',
      opportunityScore: 80, minOpportunity: 35, justifiedByScore: true, justifiedByFinding: false, briefRulesVersion: 'x',
    });
    await handle.db.insert(demoV2Artifacts).values({ id: artifactId, leadId, demoDecisionId: decisionId, schemaVersion: 'demo-v2-artifact-1', status: 'INTELLIGENCE_PENDING' });

    // Persist a LEAD_FACT-only Milestone 2 foundation so the experience-plan FK target exists
    // (CAPTURE_EVIDENCE sources need capture rows we do not seed here).
    const foundationFixture = germanClinicFixtureInput(manifests);
    foundationFixture.artifactId = artifactId;
    foundationFixture.fixtureId = 'render-persist-seed';
    foundationFixture.sources = foundationFixture.sources.filter((s) => s.kind === 'LEAD_FACT');
    foundationFixture.pages = [];
    foundationFixture.assetFetchResults = {};
    await handle.db.insert(leadFacts).values(foundationFixture.sources.map((s) => ({
      id: s.id, leadId, factType: s.key.slice('fact.'.length), value: s.value, sourceType: 'mock', confidence: 1,
    })));
    const foundation = await orchestrateDemoV2Fixture(foundationFixture);
    await new DemoV2UnitOfWork(handle.db).orchestrate((repo) => repo.persistFoundation(foundation));
    const plan = (await handle.db.select().from(demoV2ExperiencePlans).where(eq(demoV2ExperiencePlans.artifactId, artifactId)))[0]!;

    // The full acceptance render is produced in-memory only (no DB writes) for its render hash.
    const { renderInput, orchestration } = await buildAcceptanceFixture(manifests);
    renderInput.artifactId = artifactId;
    const render = renderDemoV2(renderInput);
    const quality = runQualityChecks({
      documents: render.documents, primaryLanguage: render.primaryLanguage, supportedLanguages: render.supportedLanguages,
      bundledAssetPaths: render.files.map((f) => f.path), expectedAnchors: render.sectionAnchors, faqTopicCount: renderInput.faq.entries.length,
    });
    return { artifactId, planId: plan.id, render, quality, renderInput, orchestration };
  }

  it('persists an immutable, versioned render + screenshots + review package; a new render supersedes', async () => {
    const seeded = await seedArtifactAndRender();
    const uow = new DemoV2UnitOfWork(handle.db);

    const first = await uow.render((repo) => repo.persistRenderVersion({
      artifactId: seeded.artifactId, experiencePlanId: seeded.planId, rendererVersion: seeded.render.rendererVersion,
      referenceFamily: 'advanced-specialist-clinic', bundleLocation: './demos/demo-v2', primaryLanguage: seeded.render.primaryLanguage,
      supportedLanguages: seeded.render.supportedLanguages, intelligenceHash: seeded.renderInput.intelligenceHash,
      contentHash: seeded.renderInput.primary.contentHash, translationHash: seeded.orchestration.translation?.translationHash ?? null,
      assetSelectionSetHash: fakeHash('assets'), componentRegistryHash: manifests.componentHash, referenceLibraryHash: manifests.referenceHash,
      creativeBriefHash: seeded.renderInput.creativeBriefHash, experiencePlanHash: seeded.renderInput.experiencePlanHash,
      renderHash: seeded.render.renderHash, structurallyEligible: seeded.quality.structurallyEligible, deterministicValidation: { blockers: [] },
    }));
    expect(first.version).toBe(1);

    // screenshots: ORIGINAL desktop/tablet/mobile + FINAL for every supported language
    const shots = [
      shot('ORIGINAL', 'de', 'DESKTOP', 'o-de-d'), shot('ORIGINAL', 'de', 'TABLET', 'o-de-t'), shot('ORIGINAL', 'de', 'MOBILE', 'o-de-m'),
      ...seeded.render.supportedLanguages.flatMap((lang) => (['DESKTOP', 'TABLET', 'MOBILE'] as const).map((vp) => shot('FINAL', lang, vp, `f-${lang}-${vp}`))),
    ];
    const setHash = reviewScreenshotSetHash(shots.map((s) => ({ kind: s.kind, language: s.language, viewport: s.viewport, path: s.location, width: s.width, height: s.height, fileHash: s.fileHash })));
    await uow.render((repo) => repo.persistScreenshots(first.id, seeded.render.rendererVersion, seeded.render.renderHash, setHash, shots));
    expect(await handle.db.select().from(demoV2Screenshots).where(eq(demoV2Screenshots.renderVersionId, first.id))).toHaveLength(shots.length);

    const pkg = await uow.render((repo) => repo.persistReviewPackage(seeded.artifactId, first.id, {
      schemaVersion: 'demo-v2-review-package-1', referenceFamily: 'advanced-specialist-clinic', rendererVersion: seeded.render.rendererVersion,
      primaryLanguage: seeded.render.primaryLanguage, supportedLanguages: seeded.render.supportedLanguages,
      payload: { note: 'fixture' }, renderHash: seeded.render.renderHash, screenshotSetHash: setHash,
      reviewPackageHash: fakeHash('review'), structurallyEligible: true,
    }));
    const savedPkg = (await handle.db.select().from(demoV2ReviewPackages).where(eq(demoV2ReviewPackages.id, pkg.id)))[0]!;
    expect(savedPkg.deploymentEligible).toBe(false);
    expect(savedPkg.isCurrent).toBe(true);

    // a second render supersedes the first (history retained, one current)
    const second = await uow.render((repo) => repo.persistRenderVersion({
      artifactId: seeded.artifactId, experiencePlanId: seeded.planId, rendererVersion: seeded.render.rendererVersion,
      referenceFamily: 'advanced-specialist-clinic', bundleLocation: './demos/demo-v2', primaryLanguage: 'de',
      supportedLanguages: ['de', 'en'], intelligenceHash: seeded.renderInput.intelligenceHash, contentHash: seeded.renderInput.primary.contentHash,
      translationHash: null, assetSelectionSetHash: fakeHash('assets2'), componentRegistryHash: manifests.componentHash, referenceLibraryHash: manifests.referenceHash,
      creativeBriefHash: seeded.renderInput.creativeBriefHash, experiencePlanHash: seeded.renderInput.experiencePlanHash,
      renderHash: fakeHash('render2'), structurallyEligible: true, deterministicValidation: { blockers: [] },
    }));
    expect(second.version).toBe(2);
    const versions = await handle.db.select().from(demoV2RenderVersions).where(eq(demoV2RenderVersions.artifactId, seeded.artifactId));
    expect(versions).toHaveLength(2);
    expect(versions.filter((v) => v.isCurrent)).toHaveLength(1);
    expect(versions.find((v) => v.isCurrent)?.version).toBe(2);
    expect(versions.find((v) => v.version === 1)?.status).toBe('SUPERSEDED');
  }, 40_000);

  it('refuses a review package whose render or screenshot set is stale, or that is missing screenshots', async () => {
    const seeded = await seedArtifactAndRender();
    const uow = new DemoV2UnitOfWork(handle.db);
    const rv = await uow.render((repo) => repo.persistRenderVersion({
      artifactId: seeded.artifactId, experiencePlanId: seeded.planId, rendererVersion: seeded.render.rendererVersion,
      referenceFamily: 'advanced-specialist-clinic', bundleLocation: './x', primaryLanguage: 'de', supportedLanguages: ['de', 'en'],
      intelligenceHash: HASH, contentHash: HASH, translationHash: null, assetSelectionSetHash: HASH, componentRegistryHash: manifests.componentHash,
      referenceLibraryHash: manifests.referenceHash, creativeBriefHash: HASH, experiencePlanHash: HASH, renderHash: seeded.render.renderHash,
      structurallyEligible: true, deterministicValidation: {},
    }));
    // stale render hash
    await expect(uow.render((repo) => repo.persistReviewPackage(seeded.artifactId, rv.id, {
      schemaVersion: 'v', referenceFamily: 'x', rendererVersion: 'r', primaryLanguage: 'de', supportedLanguages: ['de', 'en'],
      payload: {}, renderHash: fakeHash('different'), screenshotSetHash: HASH, reviewPackageHash: HASH, structurallyEligible: true,
    }))).rejects.toThrow('demo_v2_review_package_stale_render');
    // missing screenshots
    await expect(uow.render((repo) => repo.persistReviewPackage(seeded.artifactId, rv.id, {
      schemaVersion: 'v', referenceFamily: 'x', rendererVersion: 'r', primaryLanguage: 'de', supportedLanguages: ['de', 'en'],
      payload: {}, renderHash: seeded.render.renderHash, screenshotSetHash: HASH, reviewPackageHash: HASH, structurallyEligible: true,
    }))).rejects.toThrow('demo_v2_review_package_missing_screenshot');
  }, 40_000);
});
