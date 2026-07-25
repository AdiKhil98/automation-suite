import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { renderDemoV2 } from '../../src/domain/demo-v2/render/renderer.js';
import { runQualityChecks } from '../../src/domain/demo-v2/render/quality-checks.js';
import { reviewScreenshotSetHash } from '../../src/domain/demo-v2/render/review-package.js';
import { parseComponentRegistry } from '../../src/domain/demo-v2/manifests/component-registry.js';
import { parseReferenceLibrary } from '../../src/domain/demo-v2/manifests/reference-library.js';
import { demoV2Hash } from '../../src/domain/demo-v2/hash.js';
import { buildReviewPackage } from '../../src/cli/commands/demo-v2-render.js';
import { persistRenderBundle } from '../../src/cli/commands/demo-v2-persist.js';
import { buildAcceptanceFixture } from '../../src/fixtures/demo-v2-render-fixture.js';
import { type DbHandle } from '../../src/persistence/db.js';
import { DemoV2RenderRepository } from '../../src/persistence/repositories/demo-v2-render.repo.js';
import { demoV2Artifacts, demoV2RenderVersions, demoV2Screenshots, demoV2ReviewPackages } from '../../src/persistence/schema.js';
import { requireIntegrationTestDatabase } from '../support/test-database.js';

const testDatabase = requireIntegrationTestDatabase();
const component = parseComponentRegistry(JSON.parse(readFileSync('design-library/component-registry.v1.json', 'utf8')) as unknown);
const reference = parseReferenceLibrary(JSON.parse(readFileSync('design-library/reference-library.v1.json', 'utf8')) as unknown);
const manifests = {
  componentVersion: component.manifest.version, componentHash: component.hash,
  referenceVersion: reference.manifest.version, referenceHash: reference.hash,
};
const CONFIG = { DEMO_ENGINE_VERSION: 'v2', DEMO_V2_ENABLED: true } as never;

// Reuse the guarded test database URL for the persistence path (the guard validates it).
const TEST_URL = process.env.TEST_DATABASE_URL;
const persistEnv = { ALLOW_DEMO_V2_PERSIST: 'true', DEMO_V2_PERSIST_DATABASE_URL: TEST_URL };
Object.assign(process.env, persistEnv);

/** Build a bundle + deterministic screenshots (no browser) for a render input. */
async function makeBundleAndShots(language: 'de') {
  const { renderInput, orchestration } = await buildAcceptanceFixture(manifests);
  const render = renderDemoV2(renderInput);
  const quality = runQualityChecks({
    documents: render.documents, primaryLanguage: render.primaryLanguage, supportedLanguages: render.supportedLanguages,
    bundledAssetPaths: render.files.map((f) => f.path), expectedAnchors: render.sectionAnchors, faqTopicCount: renderInput.faq.entries.length,
  });
  const bundle = {
    outDir: './demos/demo-v2', language, render, quality,
    brief: orchestration.creativeBrief.brief as Record<string, unknown>,
    plan: orchestration.experiencePlan.plan as Record<string, unknown>,
    artifactId: renderInput.artifactId,
    intelligenceHash: renderInput.intelligenceHash, contentHash: renderInput.primary.contentHash,
    translationHash: orchestration.translation?.translationHash ?? null,
    assetSelectionSetHash: demoV2Hash([...orchestration.selections].map((s) => s.selectionHash).sort()),
    creativeBriefHash: renderInput.creativeBriefHash, experiencePlanHash: renderInput.experiencePlanHash,
    componentRegistryHash: manifests.componentHash, referenceLibraryHash: manifests.referenceHash,
    referenceFamily: renderInput.referenceFamily,
  };
  // Deterministic fake screenshots covering ORIGINAL primary + FINAL every language / viewport.
  const shotEntries = [
    { kind: 'ORIGINAL' as const, language: 'de' },
    ...render.supportedLanguages.map((l) => ({ kind: 'FINAL' as const, language: l })),
  ].flatMap((base) => (['DESKTOP', 'TABLET', 'MOBILE'] as const).map((viewport) => ({
    kind: base.kind, language: base.language, viewport,
    width: 1440, height: 1000, path: `screenshots/${base.kind}-${base.language}-${viewport}.png`,
    fileHash: demoV2Hash(`${base.kind}-${base.language}-${viewport}`),
  })));
  const shots = { screenshots: shotEntries, screenshotSetHash: reviewScreenshotSetHash(shotEntries), outDir: './demos/demo-v2/screenshots' };
  return { bundle, shots, pkg: buildReviewPackage(bundle, shots) };
}

describe('Demo V2 persistence round-trip (PostgreSQL)', () => {
  let handle: DbHandle;
  beforeEach(async () => { handle ??= testDatabase.createHandle(); await testDatabase.truncate(handle.db); });
  afterAll(async () => { if (handle) await handle.pool.end(); });

  it('persists render + screenshots + review package with the correct lifecycle; filesystem hashes match the DB', async () => {
    const { bundle, shots, pkg } = await makeBundleAndShots('de');
    const result = await persistRenderBundle(CONFIG, bundle, shots, pkg);

    expect(result.lifecycle).toEqual(['RENDERING', 'RENDERED', 'AUTO_REVIEW_PENDING']);
    expect(result.renderVersion).toBe(1);

    const rv = (await handle.db.select().from(demoV2RenderVersions).where(eq(demoV2RenderVersions.artifactId, result.artifactId)))[0]!;
    expect(rv.renderHash).toBe(bundle.render.renderHash);
    expect(rv.contentHash).toBe(bundle.contentHash);
    expect(rv.structurallyEligible).toBe(true);
    const dbShots = await handle.db.select().from(demoV2Screenshots).where(eq(demoV2Screenshots.renderVersionId, rv.id));
    expect(dbShots).toHaveLength(shots.screenshots.length);
    expect(dbShots.every((s) => s.screenshotSetHash === shots.screenshotSetHash)).toBe(true);

    const review = (await handle.db.select().from(demoV2ReviewPackages).where(eq(demoV2ReviewPackages.artifactId, result.artifactId)))[0]!;
    expect(review.renderHash).toBe(bundle.render.renderHash);
    expect(review.screenshotSetHash).toBe(shots.screenshotSetHash);
    expect(review.deploymentEligible).toBe(false);

    const artifact = (await handle.db.select().from(demoV2Artifacts).where(eq(demoV2Artifacts.id, result.artifactId)))[0]!;
    expect(artifact.status).toBe('AUTO_REVIEW_PENDING');
    expect(['AUTO_REVIEW_PASSED', 'HUMAN_APPROVED']).not.toContain(artifact.status);
  }, 60_000);

  it('fails closed when a review package is missing required screenshots', async () => {
    const { bundle, pkg } = await makeBundleAndShots('de');
    // Only desktop screenshots — tablet/mobile absent.
    const partial = pkg.screenshots.filter((s) => s.viewport === 'DESKTOP');
    const shots = { screenshots: partial, screenshotSetHash: reviewScreenshotSetHash(partial), outDir: './x' };
    // reviewPackageSchema itself rejects an incomplete screenshot set before persistence.
    expect(() => buildReviewPackage(bundle, shots)).toThrow();
  }, 60_000);

  it('a second persisted render supersedes the first (history retained, one current)', async () => {
    const first = await makeBundleAndShots('de');
    const r1 = await persistRenderBundle(CONFIG, first.bundle, first.shots, first.pkg);
    // Reuse the first artifact so the second render is a new version of the SAME artifact.
    const second = await makeBundleAndShots('de');
    second.bundle.artifactId = r1.artifactId;
    // Point the second render at the first artifact's experience plan (FK) and bump the hash.
    const repo = new DemoV2RenderRepository(handle.db);
    const plan = (await handle.db.select().from(demoV2RenderVersions).where(eq(demoV2RenderVersions.artifactId, r1.artifactId)))[0]!;
    const v2 = await repo.persistRenderVersion({
      artifactId: r1.artifactId, experiencePlanId: plan.experiencePlanId, rendererVersion: first.bundle.render.rendererVersion,
      referenceFamily: first.bundle.referenceFamily, bundleLocation: './demos', primaryLanguage: 'de', supportedLanguages: ['de', 'en'],
      intelligenceHash: first.bundle.intelligenceHash, contentHash: first.bundle.contentHash, translationHash: null,
      assetSelectionSetHash: demoV2Hash('v2-assets'), componentRegistryHash: manifests.componentHash, referenceLibraryHash: manifests.referenceHash,
      creativeBriefHash: first.bundle.creativeBriefHash, experiencePlanHash: first.bundle.experiencePlanHash,
      renderHash: demoV2Hash('v2-render'), structurallyEligible: true, deterministicValidation: {},
    });
    expect(v2.version).toBe(2);
    const versions = await handle.db.select().from(demoV2RenderVersions).where(eq(demoV2RenderVersions.artifactId, r1.artifactId));
    expect(versions).toHaveLength(2);
    expect(versions.filter((v) => v.isCurrent)).toHaveLength(1);
    expect(versions.find((v) => v.isCurrent)?.version).toBe(2);
    expect(versions.find((v) => v.version === 1)?.status).toBe('SUPERSEDED');
  }, 60_000);
});
