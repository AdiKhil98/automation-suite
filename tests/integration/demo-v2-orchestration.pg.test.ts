import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { parseComponentRegistry } from '../../src/domain/demo-v2/manifests/component-registry.js';
import { parseReferenceLibrary } from '../../src/domain/demo-v2/manifests/reference-library.js';
import { demoV2ArtifactStatusSchema } from '../../src/domain/demo-v2/artifact-lifecycle.js';
import { orchestrateDemoV2Fixture } from '../../src/domain/demo-v2/orchestration-service.js';
import { demoV2Fixture } from '../../src/fixtures/demo-v2-orchestration.js';
import { type DbHandle } from '../../src/persistence/db.js';
import { DemoV2UnitOfWork } from '../../src/persistence/demo-v2-unit-of-work.js';
import {
  demoDecisions,
  demos,
  demoV2Artifacts,
  demoV2AssetCatalogs,
  demoV2AssetReuseReviews,
  demoV2AssetSelections,
  demoV2Assets,
  demoV2ClinicIntelligencePackages,
  demoV2ContentItems,
  demoV2CreativeBriefs,
  demoV2ExperiencePlans,
  demoV2PrimaryContentPackages,
  leadFacts,
  leads,
} from '../../src/persistence/schema.js';
import { requireIntegrationTestDatabase } from '../support/test-database.js';

const testDatabase = requireIntegrationTestDatabase();
const component = parseComponentRegistry(JSON.parse(readFileSync(
  'design-library/component-registry.v1.json', 'utf8',
)) as unknown);
const reference = parseReferenceLibrary(JSON.parse(readFileSync(
  'design-library/reference-library.v1.json', 'utf8',
)) as unknown);
const manifests = {
  componentVersion: component.manifest.version,
  componentHash: component.hash,
  referenceVersion: reference.manifest.version,
  referenceHash: reference.hash,
};

describe('Demo V2 Milestone 2 orchestration persistence (PostgreSQL)', () => {
  let handle: DbHandle;

  beforeEach(async () => {
    handle ??= testDatabase.createHandle();
    await testDatabase.truncate(handle.db);
  });

  afterAll(async () => {
    if (handle) await handle.pool.end();
  });

  it('persists an immutable foundation, stops at human review, and leaves V1 unchanged', async () => {
    const leadId = randomUUID();
    const decisionId = randomUUID();
    const artifactId = randomUUID();
    const v1DemoId = randomUUID();
    await handle.db.insert(leads).values({ id: leadId, status: 'DEMO_READY' });
    await handle.db.insert(demoDecisions).values({
      id: decisionId,
      leadId,
      decision: 'BUILD_DEMO',
      outcome: 'BUILD',
      reason: 'fictional Milestone 2 integration fixture',
      opportunityScore: 80,
      minOpportunity: 35,
      justifiedByScore: true,
      justifiedByFinding: false,
      briefRulesVersion: 'demo-v2-m2-fixture-1',
    });
    await handle.db.insert(demos).values({
      id: v1DemoId,
      leadId,
      demoDecisionId: decisionId,
      templateId: 'v1-control',
      templateVersion: '1',
      path: './fictional-v1-control',
      status: 'APPROVED',
      contentHash: 'v1-unchanged',
    });
    await handle.db.insert(demoV2Artifacts).values({
      id: artifactId,
      leadId,
      demoDecisionId: decisionId,
      schemaVersion: 'demo-v2-artifact-1',
      status: 'INTELLIGENCE_PENDING',
    });
    const v1Before = (await handle.db.select().from(demos).where(eq(demos.id, v1DemoId)))[0];

    const fixture = demoV2Fixture('english-specialist-clinic', manifests);
    fixture.fixtureId = 'integration-english-specialist';
    fixture.artifactId = artifactId;
    fixture.sources = fixture.sources.filter((source) => source.kind === 'LEAD_FACT');
    fixture.pages = [];
    fixture.assetFetchResults = {};
    await handle.db.insert(leadFacts).values(fixture.sources.map((source) => ({
      id: source.id,
      leadId,
      factType: source.key.slice('fact.'.length),
      value: source.value,
      sourceType: 'mock',
      sourceUrl: fixture.officialWebsiteUrl,
      capturedAt: new Date(source.capturedAt),
      confidence: 1,
    })));

    const output = await orchestrateDemoV2Fixture(fixture);
    const unitOfWork = new DemoV2UnitOfWork(handle.db);
    await unitOfWork.orchestrate(async (repository) => {
      await repository.persistFoundation(output);
      for (const status of output.report.lifecycle.slice(1)) {
        await repository.advanceArtifact(artifactId, demoV2ArtifactStatusSchema.parse(status));
      }
    });

    const artifact = (await handle.db.select().from(demoV2Artifacts)
      .where(eq(demoV2Artifacts.id, artifactId)))[0];
    expect(artifact?.status).toBe('HUMAN_REVIEW_REQUIRED');
    expect(await handle.db.select().from(demoV2ClinicIntelligencePackages)
      .where(eq(demoV2ClinicIntelligencePackages.artifactId, artifactId))).toHaveLength(1);
    expect(await handle.db.select().from(demoV2PrimaryContentPackages)
      .where(eq(demoV2PrimaryContentPackages.artifactId, artifactId))).toHaveLength(1);
    expect(await handle.db.select().from(demoV2ContentItems)
      .where(eq(demoV2ContentItems.contentPackageId, output.content.package.id)))
      .toHaveLength(output.content.package.items.length);
    expect(await handle.db.select().from(demoV2AssetCatalogs)
      .where(eq(demoV2AssetCatalogs.artifactId, artifactId))).toHaveLength(1);
    expect(await handle.db.select().from(demoV2AssetSelections)
      .where(eq(demoV2AssetSelections.artifactId, artifactId))).toHaveLength(0);
    expect(await handle.db.select().from(demoV2AssetReuseReviews)).toHaveLength(0);
    expect(await handle.db.select().from(demoV2CreativeBriefs)
      .where(eq(demoV2CreativeBriefs.artifactId, artifactId))).toHaveLength(1);
    expect(await handle.db.select().from(demoV2ExperiencePlans)
      .where(eq(demoV2ExperiencePlans.artifactId, artifactId))).toHaveLength(1);

    fixture.version = 2;
    fixture.sources.find((source) => source.key === 'fact.services')!.value = 'Oral surgery';
    const revised = await orchestrateDemoV2Fixture(fixture);
    await unitOfWork.orchestrate((repository) => repository.persistFoundation(revised));
    const intelligenceVersions = await handle.db.select().from(demoV2ClinicIntelligencePackages)
      .where(eq(demoV2ClinicIntelligencePackages.artifactId, artifactId));
    expect(intelligenceVersions).toHaveLength(2);
    expect(intelligenceVersions.find((item) => item.isCurrent)?.version).toBe(2);
    expect(await handle.db.select().from(demoV2PrimaryContentPackages)
      .where(eq(demoV2PrimaryContentPackages.artifactId, artifactId))).toHaveLength(2);
    expect(await handle.db.select().from(demoV2CreativeBriefs)
      .where(eq(demoV2CreativeBriefs.artifactId, artifactId))).toHaveLength(2);
    expect(await handle.db.select().from(demoV2ExperiencePlans)
      .where(eq(demoV2ExperiencePlans.artifactId, artifactId))).toHaveLength(2);
    expect((await handle.db.select().from(demos).where(eq(demos.id, v1DemoId)))[0]).toEqual(v1Before);
  });

  it('persists discovered assets and selection JSON, then retires every selection when a newer version has none', async () => {
    const leadId = randomUUID();
    const decisionId = randomUUID();
    const artifactId = randomUUID();
    await handle.db.insert(leads).values({ id: leadId, status: 'DEMO_READY' });
    await handle.db.insert(demoDecisions).values({
      id: decisionId,
      leadId,
      decision: 'BUILD_DEMO',
      outcome: 'BUILD',
      reason: 'fictional Milestone 2 asset-persistence fixture',
      opportunityScore: 80,
      minOpportunity: 35,
      justifiedByScore: true,
      justifiedByFinding: false,
      briefRulesVersion: 'demo-v2-m2-fixture-1',
    });
    await handle.db.insert(demoV2Artifacts).values({
      id: artifactId,
      leadId,
      demoDecisionId: decisionId,
      schemaVersion: 'demo-v2-artifact-1',
      status: 'INTELLIGENCE_PENDING',
    });

    // Populated fictional pages + asset-fetch results so the asset insert paths really execute.
    const fixture = demoV2Fixture('english-specialist-clinic', manifests);
    fixture.fixtureId = 'integration-asset-persistence';
    fixture.artifactId = artifactId;
    fixture.sources = fixture.sources.filter((source) => source.kind === 'LEAD_FACT');
    // No captured-evidence row exists in this fixture, so the asset evidence FK stays null.
    fixture.pages = fixture.pages.map((page) => ({ ...page, captureEvidenceId: null }));
    await handle.db.insert(leadFacts).values(fixture.sources.map((source) => ({
      id: source.id,
      leadId,
      factType: source.key.slice('fact.'.length),
      value: source.value,
      sourceType: 'mock',
      sourceUrl: fixture.officialWebsiteUrl,
      capturedAt: new Date(source.capturedAt),
      confidence: 1,
    })));

    const output = await orchestrateDemoV2Fixture(fixture);
    expect(output.assets.length).toBeGreaterThan(0);
    expect(output.selections.length).toBeGreaterThan(0);

    const unitOfWork = new DemoV2UnitOfWork(handle.db);
    await unitOfWork.orchestrate((repository) => repository.persistFoundation(output));

    // --- demo_v2_assets ---
    const catalogId = output.creativeBrief.assetCatalogId;
    const assetRows = await handle.db.select().from(demoV2Assets)
      .where(eq(demoV2Assets.assetCatalogId, catalogId));
    expect(assetRows).toHaveLength(output.assets.length);
    for (const asset of output.assets) {
      const row = assetRows.find((item) => item.id === asset.id)!;
      expect(row.recordHash).toBe(asset.recordHash);
      expect(row.contentHash).toBe(asset.contentHash);
      expect(row.category).toBe(asset.category);
      expect(row.qualityStatus).toBe(asset.quality);
      expect(row.firstPartyStatus).toBe(asset.ownership);
      expect(row.availabilityStatus).toBe(asset.availability);
      expect(row.width).toBe(asset.width);
      expect(row.height).toBe(asset.height);
      expect(row.aspectRatio).toBeCloseTo(asset.aspectRatio, 10);
      expect(row.sourceCaptureEvidenceId).toBeNull();
      expect(row.metadata).toEqual({ discoveryMethod: asset.discoveryMethod });
    }

    // --- demo_v2_asset_selections: every JSON column round-trips ---
    const selectionRows = await handle.db.select().from(demoV2AssetSelections)
      .where(eq(demoV2AssetSelections.artifactId, artifactId));
    expect(selectionRows).toHaveLength(output.selections.length);
    for (const selection of output.selections) {
      const row = selectionRows.find((item) => item.id === selection.id)!;
      expect(row.isCurrent).toBe(true);
      expect(row.status).toBe('REUSE_REVIEW_REQUIRED');
      expect(row.selectionKey).toBe(selection.selectionKey);
      expect(row.intendedSection).toBe(selection.intendedSection);
      expect(row.desktopCrop).toEqual(selection.desktopCrop);
      expect(row.mobileCrop).toEqual(selection.mobileCrop);
      expect(row.focalPoint).toEqual(selection.focalPoint);
      expect(row.overlay).toEqual({ guidance: selection.overlayGuidance });
      expect(row.contrastResult).toEqual({ requirement: selection.contrastRequirement, status: 'NOT_EVALUATED' });
      expect(row.fallback).toEqual({ behavior: selection.fallbackBehavior, justification: selection.justification });
      expect(row.selectionHash).toBe(selection.selectionHash);
      // The selection stays bound to the exact asset record it was proposed from.
      expect(row.boundAssetRecordHash).toBe(selection.boundAssetRecordHash);
      expect(assetRows.find((item) => item.id === row.assetId)?.recordHash).toBe(row.boundAssetRecordHash);
    }
    // Availability never grants reuse.
    expect(await handle.db.select().from(demoV2AssetReuseReviews)).toHaveLength(0);

    // --- a newer version with NO usable assets must leave no stale current selection ---
    const revised = structuredClone(fixture);
    revised.version = 2;
    revised.pages = [];
    revised.assetFetchResults = {};
    const revisedOutput = await orchestrateDemoV2Fixture(revised);
    expect(revisedOutput.selections).toHaveLength(0);
    await unitOfWork.orchestrate((repository) => repository.persistFoundation(revisedOutput));

    const afterRows = await handle.db.select().from(demoV2AssetSelections)
      .where(eq(demoV2AssetSelections.artifactId, artifactId));
    expect(afterRows).toHaveLength(output.selections.length); // history preserved
    expect(afterRows.filter((row) => row.isCurrent)).toHaveLength(0); // nothing stale stays current
  });
});
