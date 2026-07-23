import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { type DbHandle } from '../../src/persistence/db.js';
import {
  demoDecisions, demos, demoV2ApprovalDecisions, demoV2ApprovalInvalidations,
  demoV2ApprovalPackages, demoV2Artifacts, demoV2AssetCatalogs, demoV2AssetReuseReviews,
  demoV2AssetSelections, demoV2Assets, demoV2ClinicIntelligencePackages,
  demoV2CreativeBriefs, demoV2ExperiencePlans, demoV2PrimaryContentPackages, leads,
} from '../../src/persistence/schema.js';
import { requireIntegrationTestDatabase } from '../support/test-database.js';

const testDatabase = requireIntegrationTestDatabase();
const h = (letter: string) => letter.repeat(64);

describe('Demo Engine V2 Milestone 1 foundation (PostgreSQL)', () => {
  let handle: DbHandle;

  beforeEach(async () => {
    handle ??= testDatabase.createHandle();
    await testDatabase.truncate(handle.db);
  });

  afterAll(async () => {
    if (handle) await handle.pool.end();
  });

  async function seedFoundation() {
    const leadId = randomUUID();
    const decisionId = randomUUID();
    const artifactId = randomUUID();
    const intelligenceId = randomUUID();
    const contentId = randomUUID();
    const catalogId = randomUUID();
    const assetId = randomUUID();
    const selectionId = randomUUID();
    const reuseReviewId = randomUUID();
    const briefId = randomUUID();
    const planId = randomUUID();
    const approvalId = randomUUID();
    await handle.db.insert(leads).values({ id: leadId, status: 'DEMO_READY' });
    await handle.db.insert(demoDecisions).values({
      id: decisionId, leadId, decision: 'BUILD_DEMO', outcome: 'BUILD',
      reason: 'fictional integration fixture', opportunityScore: 80, minOpportunity: 35,
      justifiedByScore: true, justifiedByFinding: false, briefRulesVersion: 'fixture-v1',
    });
    await handle.db.insert(demoV2Artifacts).values({
      id: artifactId, leadId, demoDecisionId: decisionId, schemaVersion: 'artifact-v1',
      status: 'HUMAN_REVIEW_REQUIRED',
    });
    await handle.db.insert(demoV2ClinicIntelligencePackages).values({
      id: intelligenceId, artifactId, version: 1, schemaVersion: 'intelligence-v1',
      status: 'READY', primaryLanguage: 'de', primaryDirection: 'LTR',
      supportedLanguages: ['de'], package: { fixture: true }, inputFingerprint: h('a'),
      packageHash: h('b'), finalizedAt: new Date(),
    });
    await handle.db.insert(demoV2PrimaryContentPackages).values({
      id: contentId, artifactId, clinicIntelligencePackageId: intelligenceId,
      version: 1, schemaVersion: 'content-v1', language: 'de', direction: 'LTR',
      status: 'READY', sourceFingerprint: h('c'), contentHash: h('d'), finalizedAt: new Date(),
    });
    await handle.db.insert(demoV2AssetCatalogs).values({
      id: catalogId, artifactId, clinicIntelligencePackageId: intelligenceId,
      version: 1, schemaVersion: 'assets-v1', status: 'READY',
      sourceFingerprint: h('e'), catalogHash: h('f'), finalizedAt: new Date(),
    });
    await handle.db.insert(demoV2Assets).values({
      id: assetId, assetCatalogId: catalogId, sourcePageUrl: 'https://fixture.example/',
      category: 'HERO', availabilityStatus: 'AVAILABLE', firstPartyStatus: 'FIRST_PARTY',
      qualityStatus: 'SUITABLE', recordHash: h('1'),
    });
    await handle.db.insert(demoV2AssetSelections).values({
      id: selectionId, artifactId, assetId, selectionKey: 'hero', version: 1,
      intendedSection: 'hero', intendedUse: 'background', status: 'SELECTED',
      boundAssetRecordHash: h('1'), selectionHash: h('2'),
    });
    await handle.db.insert(demoV2AssetReuseReviews).values({
      id: reuseReviewId, assetSelectionId: selectionId, version: 1,
      decision: 'APPROVED_CONCEPT_USE', actorType: 'HUMAN', actorId: 'fixture-reviewer',
      evidenceNote: 'Fictional first-party fixture asset.', boundAssetRecordHash: h('1'),
      boundSelectionHash: h('2'), reviewHash: h('3'),
    });
    await handle.db.insert(demoV2CreativeBriefs).values({
      id: briefId, artifactId, clinicIntelligencePackageId: intelligenceId,
      primaryContentPackageId: contentId, assetCatalogId: catalogId, version: 1,
      schemaVersion: 'brief-v1', status: 'VALIDATED', brief: { fixture: true },
      inputFingerprint: h('4'), briefHash: h('5'), finalizedAt: new Date(),
    });
    await handle.db.insert(demoV2ExperiencePlans).values({
      id: planId, artifactId, creativeBriefId: briefId, primaryContentPackageId: contentId,
      version: 1, schemaVersion: 'plan-v1', status: 'VALIDATED',
      primaryLanguage: 'de', primaryDirection: 'LTR', supportedLanguages: ['de'],
      componentRegistryVersion: 'registry-v1', componentRegistryHash: h('6'),
      referenceLibraryVersion: 'references-v1', referenceLibraryHash: h('7'),
      plan: { fixture: true }, inputFingerprint: h('8'), planHash: h('9'), finalizedAt: new Date(),
    });
    await handle.db.insert(demoV2ApprovalPackages).values({
      id: approvalId, artifactId, clinicIntelligencePackageId: intelligenceId,
      primaryContentPackageId: contentId, assetCatalogId: catalogId, creativeBriefId: briefId,
      experiencePlanId: planId, schemaVersion: 'approval-v1',
      intelligenceHash: h('b'), primaryContentHash: h('d'), translationSetHash: h('a'),
      assetCatalogHash: h('f'), assetSelectionSetHash: h('2'), creativeBriefHash: h('5'),
      experiencePlanHash: h('9'), componentRegistryVersion: 'registry-v1',
      componentRegistryHash: h('6'), referenceLibraryVersion: 'references-v1',
      referenceLibraryHash: h('7'), renderHash: h('3'), screenshotSetHash: h('4'),
      qualityRubricVersion: 'quality-v1', qualityRubricHash: h('5'),
      visualReviewSetHash: h('6'), approvalPackageHash: h('7'),
    });
    return { leadId, decisionId, artifactId, approvalId };
  }

  it('persists an isolated V2 graph while leaving V1 rows queryable', async () => {
    const seeded = await seedFoundation();
    await handle.db.insert(demos).values({
      id: randomUUID(), leadId: seeded.leadId, demoDecisionId: seeded.decisionId,
      templateId: 'v1-fixture', templateVersion: '1', path: './fictional-v1',
      status: 'APPROVED',
    });
    expect(await handle.db.select().from(demoV2Artifacts)
      .where(eq(demoV2Artifacts.id, seeded.artifactId))).toHaveLength(1);
    expect(await handle.db.select().from(demos).where(eq(demos.leadId, seeded.leadId))).toHaveLength(1);
    expect((await handle.db.select().from(leads).where(eq(leads.id, seeded.leadId)))[0]?.status)
      .toBe('DEMO_READY');
  });

  it('enforces human-only final decisions and append-only invalidation uniqueness', async () => {
    const seeded = await seedFoundation();
    const binding = {
      approvalPackageId: seeded.approvalId, actorId: 'fixture-actor',
      boundApprovalPackageHash: h('7'), boundVisualReviewSetHash: h('6'),
      boundQualityRubricHash: h('5'),
    };
    await expect(handle.db.insert(demoV2ApprovalDecisions).values({
      id: randomUUID(), ...binding, decision: 'HUMAN_APPROVED', actorType: 'MODEL',
      reviewCycle: null, score: null, blockerCount: null, categoryScores: {},
    })).rejects.toThrow();
    await handle.db.insert(demoV2ApprovalDecisions).values({
      id: randomUUID(), ...binding, decision: 'AUTO_REVIEW_PASSED', actorType: 'MODEL',
      reviewCycle: 1, score: 90, blockerCount: 0, categoryScores: { visual: 80 },
    });
    await handle.db.insert(demoV2ApprovalDecisions).values({
      id: randomUUID(), ...binding, decision: 'HUMAN_APPROVED', actorType: 'HUMAN',
      reviewCycle: null, score: null, blockerCount: null, categoryScores: {},
    });
    const invalidation = {
      approvalPackageId: seeded.approvalId, reasonCode: 'RENDER_CHANGED',
      changedBindings: { renderHash: h('8') }, previousPackageHash: h('7'),
      observedFingerprint: h('8'), actorType: 'SYSTEM',
    } as const;
    await handle.db.insert(demoV2ApprovalInvalidations).values({ id: randomUUID(), ...invalidation });
    await expect(handle.db.insert(demoV2ApprovalInvalidations)
      .values({ id: randomUUID(), ...invalidation })).rejects.toThrow();
  });

  it('rejects a second current artifact for the same lead', async () => {
    const seeded = await seedFoundation();
    await expect(handle.db.insert(demoV2Artifacts).values({
      id: randomUUID(), leadId: seeded.leadId, demoDecisionId: seeded.decisionId,
      schemaVersion: 'artifact-v1', status: 'INTELLIGENCE_PENDING',
    })).rejects.toThrow();
  });
});
