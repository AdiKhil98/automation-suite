import { and, eq } from 'drizzle-orm';
import { assertDemoV2Transition, type DemoV2ArtifactStatus } from '../../domain/demo-v2/artifact-lifecycle.js';
import { type DemoV2OrchestrationOutput } from '../../domain/demo-v2/orchestration-service.js';
import { type DbExecutor } from '../db.js';
import {
  demoV2Artifacts,
  demoV2AssetCatalogs,
  demoV2AssetSelections,
  demoV2Assets,
  demoV2ClinicIntelligencePackages,
  demoV2ClinicIntelligenceSources,
  demoV2ContentItemSources,
  demoV2ContentItems,
  demoV2CreativeBriefs,
  demoV2ExperiencePlans,
  demoV2PrimaryContentPackages,
  demoV2TranslationPackages,
  demoV2TranslationRecords,
} from '../schema.js';

const MILESTONE_2_STATUSES = new Set<DemoV2ArtifactStatus>([
  'INTELLIGENCE_PENDING', 'INTELLIGENCE_READY', 'CONTENT_PENDING', 'CONTENT_READY',
  'ASSET_REVIEW_PENDING', 'FOUNDATION_READY', 'BRIEF_READY', 'PLAN_READY',
  'HUMAN_REVIEW_REQUIRED', 'BLOCKED', 'SUPERSEDED',
]);

/** Writes only Milestone 2 foundation records. It has no render, approval, deployment, or V1 methods. */
export class DemoV2OrchestrationRepository {
  constructor(private readonly db: DbExecutor) {}

  async advanceArtifact(artifactId: string, to: DemoV2ArtifactStatus): Promise<void> {
    if (!MILESTONE_2_STATUSES.has(to)) throw new Error(`demo_v2_milestone_2_status_prohibited:${to}`);
    const current = (await this.db.select({ status: demoV2Artifacts.status }).from(demoV2Artifacts)
      .where(and(eq(demoV2Artifacts.id, artifactId), eq(demoV2Artifacts.isCurrent, true))).limit(1))[0];
    if (!current) throw new Error('demo_v2_artifact_missing');
    assertDemoV2Transition(current.status as DemoV2ArtifactStatus, to);
    await this.db.update(demoV2Artifacts).set({ status: to, updatedAt: new Date() })
      .where(eq(demoV2Artifacts.id, artifactId));
  }

  async persistFoundation(output: DemoV2OrchestrationOutput): Promise<void> {
    const intelligence = output.intelligence.package;
    await this.db.update(demoV2ClinicIntelligencePackages).set({ isCurrent: false })
      .where(eq(demoV2ClinicIntelligencePackages.artifactId, intelligence.artifactId));
    await this.db.insert(demoV2ClinicIntelligencePackages).values({
      id: intelligence.id,
      artifactId: intelligence.artifactId,
      version: intelligence.version,
      schemaVersion: intelligence.schemaVersion,
      status: intelligence.status,
      primaryLanguage: intelligence.primaryLanguage,
      primaryDirection: intelligence.primaryDirection,
      supportedLanguages: intelligence.supportedLanguages,
      package: intelligence.package,
      inputFingerprint: intelligence.inputFingerprint,
      packageHash: intelligence.packageHash,
      finalizedAt: intelligence.status === 'READY' ? new Date() : null,
    });
    const sourceLinkBySourceId = new Map<string, string>();
    for (const source of output.intelligence.sources.filter((item) => item.accepted && !item.stale)) {
      const id = `${intelligence.id}:${source.id}`;
      sourceLinkBySourceId.set(source.id, id);
      await this.db.insert(demoV2ClinicIntelligenceSources).values({
        id,
        clinicIntelligencePackageId: intelligence.id,
        sourceKind: source.kind,
        sourceRole: source.role,
        leadFactId: source.kind === 'LEAD_FACT' ? source.id : null,
        auditFindingId: source.kind === 'AUDIT_FINDING' ? source.id : null,
        captureEvidenceId: source.kind === 'CAPTURE_EVIDENCE' ? source.id : null,
        evidenceId: source.kind === 'EVIDENCE' ? source.id : null,
        sourceRecordHash: source.recordHash,
        sourceCapturedAt: new Date(source.capturedAt),
      });
    }

    const content = output.content.package;
    await this.db.update(demoV2PrimaryContentPackages).set({ isCurrent: false })
      .where(eq(demoV2PrimaryContentPackages.artifactId, content.artifactId));
    await this.db.insert(demoV2PrimaryContentPackages).values({
      id: content.id,
      artifactId: content.artifactId,
      clinicIntelligencePackageId: content.clinicIntelligencePackageId,
      version: content.version,
      schemaVersion: content.schemaVersion,
      language: content.language,
      direction: content.direction,
      status: content.status,
      sourceFingerprint: content.sourceFingerprint,
      contentHash: content.contentHash,
      finalizedAt: content.status === 'READY' ? new Date() : null,
    });
    await this.db.insert(demoV2ContentItems).values(content.items.map((item) => ({
      id: item.id,
      contentPackageId: content.id,
      contentKey: item.contentKey,
      contentKind: item.contentKind,
      claimClass: item.claimClass,
      textValue: item.textValue,
      structuredValue: item.structuredValue,
      translatable: item.translatable,
      position: item.position,
      itemHash: item.itemHash,
    })));
    for (const binding of output.content.bindings) {
      const links = binding.sourceIds.map((id) => sourceLinkBySourceId.get(id))
        .filter((id): id is string => id !== undefined);
      if (links.length !== binding.sourceIds.length) throw new Error(`demo_v2_content_source_missing:${binding.contentItemId}`);
      await this.db.insert(demoV2ContentItemSources).values(links.map((intelligenceSourceId) => ({
        contentItemId: binding.contentItemId,
        intelligenceSourceId,
        relationship: binding.relationship,
      })));
    }

    if (output.translation) {
      const translation = output.translation;
      await this.db.update(demoV2TranslationPackages).set({ isCurrent: false })
        .where(and(
          eq(demoV2TranslationPackages.artifactId, translation.artifactId),
          eq(demoV2TranslationPackages.language, translation.language),
        ));
      await this.db.insert(demoV2TranslationPackages).values({
        id: translation.id,
        artifactId: translation.artifactId,
        sourceContentPackageId: translation.sourceContentPackageId,
        version: translation.version,
        language: translation.language,
        direction: translation.direction,
        status: translation.status,
        sourceContentHash: translation.sourceContentHash,
        sourceFingerprint: translation.sourceFingerprint,
        translationHash: translation.translationHash,
        reviewStatus: translation.reviewStatus,
        reviewActorType: null,
        reviewActorId: null,
      });
      await this.db.insert(demoV2TranslationRecords).values(translation.records.map((record) => ({
        id: `${translation.id}:${record.sourceContentItemId}`,
        translationPackageId: translation.id,
        sourceContentItemId: record.sourceContentItemId,
        sourceItemHash: record.sourceItemHash,
        translatedText: record.translatedText,
        translatedStructuredValue: record.translatedStructuredValue,
        translationItemHash: record.translationItemHash,
        status: record.status,
      })));
    }

    const catalogId = output.creativeBrief.assetCatalogId;
    const catalogHash = output.report.fingerprints.assets!;
    await this.db.update(demoV2AssetCatalogs).set({ isCurrent: false })
      .where(eq(demoV2AssetCatalogs.artifactId, intelligence.artifactId));
    await this.db.insert(demoV2AssetCatalogs).values({
      id: catalogId,
      artifactId: intelligence.artifactId,
      clinicIntelligencePackageId: intelligence.id,
      version: intelligence.version,
      schemaVersion: 'demo-v2-assets-1',
      status: 'READY_FOR_REVIEW',
      sourceFingerprint: intelligence.inputFingerprint,
      catalogHash,
    });
    if (output.assets.length > 0) {
      await this.db.insert(demoV2Assets).values(output.assets.map((asset) => ({
        id: asset.id,
        assetCatalogId: catalogId,
        sourceCaptureEvidenceId: asset.sourceEvidenceId,
        sourcePageUrl: asset.sourcePageUrl,
        directUrl: asset.directUrl,
        finalUrl: asset.finalUrl,
        contentHash: asset.contentHash,
        mimeType: asset.mimeType,
        byteSize: asset.byteSize,
        width: asset.width,
        height: asset.height,
        aspectRatio: asset.aspectRatio,
        altText: asset.altText,
        nearbyCaption: asset.nearbyCaption,
        nearbyHeading: asset.nearbyHeading,
        category: asset.category,
        availabilityStatus: asset.availability,
        firstPartyStatus: asset.ownership,
        qualityStatus: asset.quality,
        metadata: { discoveryMethod: asset.discoveryMethod },
        recordHash: asset.recordHash,
        capturedAt: new Date(asset.discoveredAt),
      })));
    }
    // Retire earlier selections unconditionally: a newer version that proposes NO selections must
    // still leave no stale current row behind.
    await this.db.update(demoV2AssetSelections).set({ isCurrent: false })
      .where(eq(demoV2AssetSelections.artifactId, intelligence.artifactId));
    if (output.selections.length > 0) {
      await this.db.insert(demoV2AssetSelections).values(output.selections.map((selection) => ({
        id: selection.id,
        artifactId: intelligence.artifactId,
        assetId: selection.assetId,
        selectionKey: selection.selectionKey,
        version: intelligence.version,
        intendedSection: selection.intendedSection,
        intendedUse: selection.intendedUse,
        desktopCrop: selection.desktopCrop,
        mobileCrop: selection.mobileCrop,
        focalPoint: selection.focalPoint,
        overlay: { guidance: selection.overlayGuidance },
        contrastResult: { requirement: selection.contrastRequirement, status: 'NOT_EVALUATED' },
        fallback: { behavior: selection.fallbackBehavior, justification: selection.justification },
        status: selection.status,
        boundAssetRecordHash: selection.boundAssetRecordHash,
        selectionHash: selection.selectionHash,
      })));
    }

    await this.db.update(demoV2CreativeBriefs).set({ isCurrent: false })
      .where(eq(demoV2CreativeBriefs.artifactId, intelligence.artifactId));
    await this.db.insert(demoV2CreativeBriefs).values({
      ...output.creativeBrief,
      finalizedAt: new Date(),
    });
    await this.db.update(demoV2ExperiencePlans).set({ isCurrent: false })
      .where(eq(demoV2ExperiencePlans.artifactId, intelligence.artifactId));
    await this.db.insert(demoV2ExperiencePlans).values({
      ...output.experiencePlan,
      finalizedAt: new Date(),
    });
  }
}
