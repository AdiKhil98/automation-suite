import { randomUUID } from 'node:crypto';
import { parseComponentRegistry } from '../../domain/demo-v2/manifests/component-registry.js';
import { parseReferenceLibrary } from '../../domain/demo-v2/manifests/reference-library.js';
import { orchestrateDemoV2Fixture } from '../../domain/demo-v2/orchestration-service.js';
import { demoV2ArtifactStatusSchema, type DemoV2ArtifactStatus } from '../../domain/demo-v2/artifact-lifecycle.js';
import { acceptanceFixtureInput } from '../../fixtures/demo-v2-multilang-fixture.js';
import { readFile } from 'node:fs/promises';
import { createDb } from '../../persistence/db.js';
import { requireDemoV2PersistDatabase } from '../../persistence/demo-v2-persist-guard.js';
import { DemoV2UnitOfWork } from '../../persistence/demo-v2-unit-of-work.js';
import {
  demoDecisions, demoV2Artifacts, demoV2ExperiencePlans, leadFacts, leads,
} from '../../persistence/schema.js';
import { eq } from 'drizzle-orm';
import { type AppConfig } from '../../config/env.js';
import {
  buildReviewPackage, captureScreenshots, renderFixtureBundle,
  type RenderedBundle, type RenderLanguage, type ScreenshotOutcome,
} from './demo-v2-render.js';
import { DemoV2RenderRepository } from '../../persistence/repositories/demo-v2-render.repo.js';
import { reviewPackageHash, type DemoV2ReviewPackage } from '../../domain/demo-v2/render/review-package.js';

/**
 * Persist a rendered bundle + screenshots + review package into the Milestone 3B1 tables under the
 * dedicated guarded database. The artifact advances HUMAN_REVIEW_REQUIRED → RENDERING → RENDERED →
 * AUTO_REVIEW_PENDING; it never reaches AUTO_REVIEW_PASSED, HUMAN_APPROVED, or deployment eligibility.
 * All records are immutable; a later render creates a new version and supersedes the previous one.
 */

export interface PersistResult {
  databaseName: string;
  artifactId: string;
  renderVersion: number;
  renderHash: string;
  screenshotCount: number;
  screenshotSetHash: string;
  reviewPackageHash: string;
  lifecycle: DemoV2ArtifactStatus[];
}

async function manifests() {
  const component = parseComponentRegistry(JSON.parse(await readFile('./design-library/component-registry.v1.json', 'utf8')) as unknown);
  const reference = parseReferenceLibrary(JSON.parse(await readFile('./design-library/reference-library.v1.json', 'utf8')) as unknown);
  return {
    componentVersion: component.manifest.version, componentHash: component.hash,
    referenceVersion: reference.manifest.version, referenceHash: reference.hash,
  };
}

export async function persistRenderBundle(
  config: AppConfig,
  bundle: RenderedBundle,
  shots: ScreenshotOutcome,
  reviewPackage: DemoV2ReviewPackage,
): Promise<PersistResult> {
  // Gates: V2 must be enabled AND an explicit dedicated guarded database must be configured.
  if (config.DEMO_ENGINE_VERSION !== 'v2' || !config.DEMO_V2_ENABLED) {
    throw new Error('demo_v2_persist_blocked:DEMO_V2_ENABLED_required');
  }
  const permit = requireDemoV2PersistDatabase();
  const { db, pool } = createDb(permit.databaseUrl);
  const databaseName = new URL(permit.databaseUrl).pathname.replace(/^\/+/, '');
  const lifecycle: DemoV2ArtifactStatus[] = [];
  try {
    const uow = new DemoV2UnitOfWork(db);
    const leadId = randomUUID();
    const decisionId = randomUUID();
    const artifactId = randomUUID();

    // Seed a fixture lead + decision + artifact, then a LEAD_FACT-only Milestone 2 foundation so the
    // render-version FK (experience plan) exists and the artifact can reach HUMAN_REVIEW_REQUIRED.
    const foundationFixture = acceptanceFixtureInput(bundle.language, await manifests());
    foundationFixture.artifactId = artifactId;
    foundationFixture.fixtureId = `persist-${bundle.language}-${artifactId.slice(0, 8)}`;
    foundationFixture.sources = foundationFixture.sources.filter((s) => s.kind === 'LEAD_FACT');
    foundationFixture.pages = [];
    foundationFixture.assetFetchResults = {};

    await db.insert(leads).values({ id: leadId, status: 'DEMO_READY' });
    await db.insert(demoDecisions).values({
      id: decisionId, leadId, decision: 'BUILD_DEMO', outcome: 'BUILD', reason: 'demo-v2 render persistence',
      opportunityScore: 80, minOpportunity: 35, justifiedByScore: true, justifiedByFinding: false, briefRulesVersion: 'demo-v2',
    });
    await db.insert(demoV2Artifacts).values({ id: artifactId, leadId, demoDecisionId: decisionId, schemaVersion: 'demo-v2-artifact-1', status: 'INTELLIGENCE_PENDING' });
    await db.insert(leadFacts).values(foundationFixture.sources.map((s) => ({
      id: s.id, leadId, factType: s.key.slice('fact.'.length), value: s.value, sourceType: 'mock', confidence: 1,
    })));

    const foundation = await orchestrateDemoV2Fixture(foundationFixture);
    await uow.orchestrate(async (repo) => {
      await repo.persistFoundation(foundation);
      for (const status of foundation.report.lifecycle.slice(1)) {
        await repo.advanceArtifact(artifactId, demoV2ArtifactStatusSchema.parse(status));
      }
    });
    const plan = (await db.select().from(demoV2ExperiencePlans).where(eq(demoV2ExperiencePlans.artifactId, artifactId)))[0]!;

    // Lifecycle: HUMAN_REVIEW_REQUIRED → RENDERING → RENDERED → (persist) → AUTO_REVIEW_PENDING.
    const persisted = await uow.render(async (repo) => {
      await repo.advanceArtifact(artifactId, 'RENDERING');
      lifecycle.push('RENDERING');
      const version = await repo.persistRenderVersion({
        artifactId, experiencePlanId: plan.id, rendererVersion: bundle.render.rendererVersion,
        referenceFamily: bundle.referenceFamily, bundleLocation: bundle.outDir, primaryLanguage: bundle.render.primaryLanguage,
        supportedLanguages: bundle.render.supportedLanguages, intelligenceHash: bundle.intelligenceHash,
        contentHash: bundle.contentHash, translationHash: bundle.translationHash, assetSelectionSetHash: bundle.assetSelectionSetHash,
        componentRegistryHash: bundle.componentRegistryHash, referenceLibraryHash: bundle.referenceLibraryHash,
        creativeBriefHash: bundle.creativeBriefHash, experiencePlanHash: bundle.experiencePlanHash,
        renderHash: bundle.render.renderHash, structurallyEligible: bundle.quality.structurallyEligible,
        deterministicValidation: reviewPackage.deterministicValidation,
      });
      await repo.advanceArtifact(artifactId, 'RENDERED');
      lifecycle.push('RENDERED');
      await repo.persistScreenshots(version.id, bundle.render.rendererVersion, bundle.render.renderHash, shots.screenshotSetHash,
        shots.screenshots.map((s) => ({
          kind: s.kind, language: s.language, viewport: s.viewport, width: s.width, height: s.height,
          fileHash: s.fileHash, location: s.path,
        })));
      // Fail-closed review-package finalization (missing screenshots / stale hashes throw here).
      await repo.persistReviewPackage(artifactId, version.id, {
        schemaVersion: reviewPackage.schemaVersion, referenceFamily: bundle.referenceFamily, rendererVersion: bundle.render.rendererVersion,
        primaryLanguage: bundle.render.primaryLanguage, supportedLanguages: bundle.render.supportedLanguages,
        payload: reviewPackage, renderHash: bundle.render.renderHash, screenshotSetHash: shots.screenshotSetHash,
        reviewPackageHash: reviewPackageHash(reviewPackage), structurallyEligible: bundle.quality.structurallyEligible,
      });
      await repo.advanceArtifact(artifactId, 'AUTO_REVIEW_PENDING');
      lifecycle.push('AUTO_REVIEW_PENDING');
      return version;
    });

    return {
      databaseName, artifactId, renderVersion: persisted.version, renderHash: bundle.render.renderHash,
      screenshotCount: shots.screenshots.length, screenshotSetHash: shots.screenshotSetHash,
      reviewPackageHash: reviewPackageHash(reviewPackage), lifecycle,
    };
  } finally {
    await pool.end();
  }
}

/** Operator command: render a fixture, capture screenshots, and persist under the guarded DB. */
export async function demoV2PersistCommand(config: AppConfig, opts: { out?: string; family?: string; language?: RenderLanguage; noEnglish?: boolean }): Promise<void> {
  const bundle = await renderFixtureBundle({ outDir: opts.out, referenceFamily: opts.family, language: opts.language, withEnglish: !opts.noEnglish });
  const shots = await captureScreenshots(bundle);
  const pkg = buildReviewPackage(bundle, shots);
  const result = await persistRenderBundle(config, bundle, shots, pkg);
  console.log('Demo V2 render persisted (guarded local database only):');
  console.log(`  database        : ${result.databaseName}`);
  console.log(`  artifact        : ${result.artifactId}`);
  console.log(`  render version  : ${String(result.renderVersion)}`);
  console.log(`  render hash     : ${result.renderHash}`);
  console.log(`  screenshots     : ${String(result.screenshotCount)} (set ${result.screenshotSetHash})`);
  console.log(`  review package  : ${result.reviewPackageHash}`);
  console.log(`  lifecycle       : HUMAN_REVIEW_REQUIRED → ${result.lifecycle.join(' → ')}`);
  console.log('  deployment eligible: false; AUTO_REVIEW_PASSED / HUMAN_APPROVED not set.');
}

/** Read-only inspection of persisted render versions / screenshots / review packages / lifecycle. */
export async function demoV2PersistStatusCommand(config: AppConfig, opts: { limit?: string }): Promise<void> {
  if (config.DEMO_ENGINE_VERSION !== 'v2' || !config.DEMO_V2_ENABLED) {
    throw new Error('demo_v2_persist_blocked:DEMO_V2_ENABLED_required');
  }
  const permit = requireDemoV2PersistDatabase();
  const { db, pool } = createDb(permit.databaseUrl);
  try {
    const repo = new DemoV2RenderRepository(db);
    const versions = await repo.recentRenderVersions(Number.parseInt(opts.limit ?? '10', 10));
    console.log(`Demo V2 persisted render versions (${new URL(permit.databaseUrl).pathname.replace(/^\/+/, '')}): ${String(versions.length)}\n`);
    for (const version of versions) {
      const shots = await repo.screenshotsForVersion(version.id);
      const review = await repo.currentReviewPackage(version.artifactId);
      const status = await repo.artifactStatus(version.artifactId);
      console.log(`  artifact ${version.artifactId} v${String(version.version)} [${version.isCurrent ? 'current' : version.status}] lifecycle=${status ?? '?'}`);
      console.log(`    reference family : ${version.referenceFamily}  languages: ${(version.supportedLanguages as string[]).join(', ')}`);
      console.log(`    render hash      : ${version.renderHash}`);
      console.log(`    screenshots      : ${String(shots.length)}  (set ${shots[0]?.screenshotSetHash ?? 'n/a'})`);
      console.log(`    review package   : ${review?.reviewPackageHash ?? '(none)'}  deploymentEligible=${String(review?.deploymentEligible ?? false)}`);
      console.log(`    structurally eligible: ${String(version.structurallyEligible)}\n`);
    }
  } finally {
    await pool.end();
  }
}
