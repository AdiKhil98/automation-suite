import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { renderDemoV2 } from '../../src/domain/demo-v2/render/renderer.js';
import { runQualityChecks } from '../../src/domain/demo-v2/render/quality-checks.js';
import { reviewPackageHash, reviewScreenshotSetHash } from '../../src/domain/demo-v2/render/review-package.js';
import { parseComponentRegistry } from '../../src/domain/demo-v2/manifests/component-registry.js';
import { parseReferenceLibrary } from '../../src/domain/demo-v2/manifests/reference-library.js';
import { demoV2Hash } from '../../src/domain/demo-v2/hash.js';
import { buildReviewPackage } from '../../src/cli/commands/demo-v2-render.js';
import { persistRenderBundle } from '../../src/cli/commands/demo-v2-persist.js';
import { buildAcceptanceFixture } from '../../src/fixtures/demo-v2-render-fixture.js';
import { type DbHandle } from '../../src/persistence/db.js';
import { DemoV2RenderRepository } from '../../src/persistence/repositories/demo-v2-render.repo.js';
import { DemoV2VisualReviewRepository } from '../../src/persistence/repositories/demo-v2-visual-review.repo.js';
import { demoV2RenderVersions, demoV2ReviewPackages, demoV2VisualReviews } from '../../src/persistence/schema.js';
import { MockDemoV2VisualReviewProvider } from '../../src/domain/demo-v2/render/visual-review.js';
import { buildVisualReviewInput, visualReviewInputFingerprint } from '../../src/domain/demo-v2/render/visual-review-input.js';
import { requireIntegrationTestDatabase } from '../support/test-database.js';

const testDatabase = requireIntegrationTestDatabase();
const component = parseComponentRegistry(JSON.parse(readFileSync('design-library/component-registry.v1.json', 'utf8')) as unknown);
const reference = parseReferenceLibrary(JSON.parse(readFileSync('design-library/reference-library.v1.json', 'utf8')) as unknown);
const manifests = {
  componentVersion: component.manifest.version, componentHash: component.hash,
  referenceVersion: reference.manifest.version, referenceHash: reference.hash,
};
const CONFIG = { DEMO_ENGINE_VERSION: 'v2', DEMO_V2_ENABLED: true } as never;
const RUBRIC_VERSION = 'demo-v2-visual-review-rubric-1';
Object.assign(process.env, { ALLOW_DEMO_V2_PERSIST: 'true', DEMO_V2_PERSIST_DATABASE_URL: process.env.TEST_DATABASE_URL });

const provenance = {
  contentClaimClasses: ['VERBATIM_FACT'], contentSourceIds: ['fact.hero'], assetSelectionIds: ['asset-hero'],
  assetRecordHashes: ['a'.repeat(64)], humanApprovedAssetReuse: false,
};

async function makeBundleAndShots() {
  const { renderInput, orchestration } = await buildAcceptanceFixture(manifests);
  const render = renderDemoV2(renderInput);
  const quality = runQualityChecks({
    documents: render.documents, primaryLanguage: render.primaryLanguage, supportedLanguages: render.supportedLanguages,
    bundledAssetPaths: render.files.map((f) => f.path), expectedAnchors: render.sectionAnchors, faqTopicCount: renderInput.faq.entries.length,
  });
  const bundle = {
    outDir: './demos/demo-v2', language: 'de' as const, render, quality,
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
  const shotEntries = [
    { kind: 'ORIGINAL' as const, language: 'de' },
    ...render.supportedLanguages.map((l) => ({ kind: 'FINAL' as const, language: l })),
  ].flatMap((base) => (['DESKTOP', 'TABLET', 'MOBILE'] as const).map((viewport) => ({
    kind: base.kind, language: base.language, viewport, width: 1440, height: 1000,
    path: `screenshots/${base.kind}-${base.language}-${viewport}.png`, fileHash: demoV2Hash(`${base.kind}-${base.language}-${viewport}`),
  })));
  const shots = { screenshots: shotEntries, screenshotSetHash: reviewScreenshotSetHash(shotEntries), outDir: './demos/demo-v2/screenshots' };
  return { bundle, shots, pkg: buildReviewPackage(bundle, shots) };
}

async function persistAndReview(handle: DbHandle, fixture: 'strong-premium-dental' | 'weak-hierarchy', runId: string, cycle: number) {
  const { bundle, shots, pkg } = await makeBundleAndShots();
  const persisted = await persistRenderBundle(CONFIG, bundle, shots, pkg);
  const pkgHash = reviewPackageHash(pkg);
  const input = buildVisualReviewInput({ reviewPackage: pkg, reviewPackageHash: pkgHash, provenance });
  const result = await new MockDemoV2VisualReviewProvider(fixture).review({
    screenshotRefs: [...input.finalScreenshots, ...input.baselineScreenshots].map((s) => s.ref),
    referenceFamily: input.referenceFamily, renderHash: input.hashes.render, screenshotSetHash: input.hashes.screenshotSet,
    reviewPackageHash: pkgHash, inputFingerprint: visualReviewInputFingerprint(input),
  });
  const rv = (await handle.db.select().from(demoV2RenderVersions).where(eq(demoV2RenderVersions.artifactId, persisted.artifactId)))[0]!;
  const reviewPkg = (await handle.db.select().from(demoV2ReviewPackages).where(eq(demoV2ReviewPackages.artifactId, persisted.artifactId)))[0]!;
  const repo = new DemoV2VisualReviewRepository(handle.db);
  const saved = await repo.persistReview({
    artifactId: persisted.artifactId, renderVersionId: rv.id, reviewPackageId: reviewPkg.id, reviewRunId: runId, cycle,
    inputFingerprint: visualReviewInputFingerprint(input), boundRenderHash: bundle.render.renderHash,
    boundScreenshotSetHash: shots.screenshotSetHash, boundReviewPackageHash: pkgHash,
    rubricVersion: RUBRIC_VERSION, rubricHash: demoV2Hash(input.rubric), result,
  });
  return { artifactId: persisted.artifactId, renderVersionId: rv.id, reviewPackageId: reviewPkg.id, result, saved, input, pkgHash };
}

describe('Demo V2 visual-review persistence (PostgreSQL, guarded)', () => {
  let handle: DbHandle;
  beforeEach(async () => { handle ??= testDatabase.createHandle(); await testDatabase.truncate(handle.db); });
  afterAll(async () => { if (handle) await handle.pool.end(); });

  it('persists an immutable review bound to the exact render/screenshot/package hashes', async () => {
    const { artifactId, result, saved } = await persistAndReview(handle, 'weak-hierarchy', 'run-1', 1);
    const row = (await handle.db.select().from(demoV2VisualReviews).where(eq(demoV2VisualReviews.artifactId, artifactId)))[0]!;
    expect(row.decision).toBe(result.decision);
    expect(row.provider).toBe('mock');
    expect(Number(row.costUsd)).toBe(0);
    expect(row.reviewOutputHash).toBe(saved.reviewOutputHash);
    expect(row.isCurrent).toBe(true);
    expect(row.stale).toBe(false);
    // Never an automatic pass.
    expect(['AUTO_REVIEW_PASSED', 'HUMAN_APPROVED']).not.toContain(row.decision);
  }, 60_000);

  it('supersedes the prior current review and retains history (immutable)', async () => {
    const first = await persistAndReview(handle, 'weak-hierarchy', 'run-2', 1);
    // A second review of a NEW render version of the SAME artifact.
    const { bundle, shots, pkg } = await makeBundleAndShots();
    bundle.artifactId = first.artifactId;
    const repoRender = new DemoV2RenderRepository(handle.db);
    const plan = (await handle.db.select().from(demoV2RenderVersions).where(eq(demoV2RenderVersions.artifactId, first.artifactId)))[0]!;
    const v2 = await repoRender.persistRenderVersion({
      artifactId: first.artifactId, experiencePlanId: plan.experiencePlanId, rendererVersion: bundle.render.rendererVersion,
      referenceFamily: bundle.referenceFamily, bundleLocation: './demos', primaryLanguage: 'de', supportedLanguages: ['de', 'en'],
      intelligenceHash: bundle.intelligenceHash, contentHash: bundle.contentHash, translationHash: null,
      assetSelectionSetHash: demoV2Hash('v2-assets'), componentRegistryHash: manifests.componentHash, referenceLibraryHash: manifests.referenceHash,
      creativeBriefHash: bundle.creativeBriefHash, experiencePlanHash: bundle.experiencePlanHash,
      renderHash: demoV2Hash('v2-render'), structurallyEligible: true, deterministicValidation: {},
    });
    await handle.db.insert(demoV2ReviewPackages).values({
      id: 'rp-v2', artifactId: first.artifactId, renderVersionId: v2.id, schemaVersion: pkg.schemaVersion,
      referenceFamily: bundle.referenceFamily, rendererVersion: bundle.render.rendererVersion, primaryLanguage: 'de',
      supportedLanguages: ['de'], payload: pkg, renderHash: demoV2Hash('v2-render'), screenshotSetHash: shots.screenshotSetHash,
      reviewPackageHash: demoV2Hash('v2-package'), structurallyEligible: true, isCurrent: false,
    });
    const repo = new DemoV2VisualReviewRepository(handle.db);
    await repo.persistReview({
      artifactId: first.artifactId, renderVersionId: v2.id, reviewPackageId: 'rp-v2', reviewRunId: 'run-2', cycle: 2,
      inputFingerprint: demoV2Hash('v2-fingerprint'), boundRenderHash: demoV2Hash('v2-render'),
      boundScreenshotSetHash: shots.screenshotSetHash, boundReviewPackageHash: demoV2Hash('v2-package'),
      rubricVersion: RUBRIC_VERSION, rubricHash: demoV2Hash('rubric'), result: first.result,
    });
    const all = await repo.reviewHistory(first.artifactId);
    expect(all).toHaveLength(2);
    expect(all.filter((r) => r.isCurrent)).toHaveLength(1);
    expect(await repo.reviewCountForRun('run-2')).toBe(2);
  }, 60_000);

  it('marks a review stale once the artifact has a newer render version', async () => {
    const first = await persistAndReview(handle, 'weak-hierarchy', 'run-3', 1);
    const repoRender = new DemoV2RenderRepository(handle.db);
    const plan = (await handle.db.select().from(demoV2RenderVersions).where(eq(demoV2RenderVersions.artifactId, first.artifactId)))[0]!;
    await repoRender.persistRenderVersion({
      artifactId: first.artifactId, experiencePlanId: plan.experiencePlanId, rendererVersion: 'x', referenceFamily: 'x',
      bundleLocation: './x', primaryLanguage: 'de', supportedLanguages: ['de'], intelligenceHash: demoV2Hash('i'), contentHash: demoV2Hash('c'),
      translationHash: null, assetSelectionSetHash: demoV2Hash('a'), componentRegistryHash: manifests.componentHash,
      referenceLibraryHash: manifests.referenceHash, creativeBriefHash: demoV2Hash('b'), experiencePlanHash: demoV2Hash('p'),
      renderHash: demoV2Hash('new-render'), structurallyEligible: true, deterministicValidation: {},
    });
    const repo = new DemoV2VisualReviewRepository(handle.db);
    const staled = await repo.markStaleReviews(first.artifactId);
    expect(staled).toBe(1);
    const current = await repo.currentReview(first.artifactId);
    expect(current?.stale).toBe(true);
  }, 60_000);

  it('accumulates prior spend and finds a review by exact fingerprint', async () => {
    const { artifactId, input } = await persistAndReview(handle, 'weak-hierarchy', 'run-4', 1);
    const repo = new DemoV2VisualReviewRepository(handle.db);
    expect(await repo.priorSpendUsd(artifactId)).toBe(0); // mock is $0
    const found = await repo.findByFingerprint(artifactId, visualReviewInputFingerprint(input));
    expect(found).not.toBeNull();
  }, 60_000);

  it('the database refuses an AUTO_REVIEW_PASSED decision', async () => {
    const { artifactId, renderVersionId, reviewPackageId, input, pkgHash } = await persistAndReview(handle, 'weak-hierarchy', 'run-5', 1);
    await expect(handle.db.insert(demoV2VisualReviews).values({
      id: 'bad', artifactId, renderVersionId, reviewPackageId, reviewRunId: 'run-5', cycle: 2, provider: 'mock',
      requestedModel: 'm', resolvedModel: 'm', reasoningEffort: 'high', schemaVersion: 'demo-v2-visual-review-2',
      inputFingerprint: visualReviewInputFingerprint(input), boundRenderHash: input.hashes.render,
      boundScreenshotSetHash: input.hashes.screenshotSet, boundReviewPackageHash: pkgHash, rubricVersion: RUBRIC_VERSION,
      rubricHash: demoV2Hash('r'), overallScore: 90, categoryScores: {}, blockers: [], findings: [],
      permittedRevisionOperations: [], decision: 'AUTO_REVIEW_PASSED', costUsd: '0', reviewOutputHash: demoV2Hash('o'),
    })).rejects.toThrow();
  }, 60_000);
});
