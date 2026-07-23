import { eq } from 'drizzle-orm';
import {
  approvalDecisionSchema, approvalPackageSchema, assertDecisionBindings,
  assertRequiredCategoryScores, computeApprovalPackageHash, screenshotSetHash,
  type ApprovalDecision, type ScreenshotSet,
} from '../../domain/demo-v2/approval-package.js';
import { assetReuseReviewSchema } from '../../domain/demo-v2/asset-catalog.js';
import { translationPackageSchema } from '../../domain/demo-v2/translation-package.js';
import { type DbExecutor } from '../db.js';
import {
  demoV2ApprovalDecisions, demoV2ApprovalInvalidations, demoV2ApprovalPackages,
  demoV2Artifacts, demoV2AssetReuseReviews, demoV2TranslationPackages,
} from '../schema.js';

type ArtifactInsert = typeof demoV2Artifacts.$inferInsert;
type TranslationInsert = typeof demoV2TranslationPackages.$inferInsert;
type ReuseReviewInsert = typeof demoV2AssetReuseReviews.$inferInsert;
type ApprovalPackageInsert = typeof demoV2ApprovalPackages.$inferInsert;
type ApprovalDecisionInsert = typeof demoV2ApprovalDecisions.$inferInsert;
type InvalidationInsert = typeof demoV2ApprovalInvalidations.$inferInsert;

/**
 * Milestone 1 exposes insert-only methods for finalized/review records. Payload
 * mutation and approval overwrite methods intentionally do not exist.
 */
export class DemoV2FoundationRepository {
  constructor(private readonly db: DbExecutor) {}

  async createArtifact(value: ArtifactInsert): Promise<void> {
    if (value.engineVersion !== undefined && value.engineVersion !== 'v2') {
      throw new Error('demo_v2_engine_version_required');
    }
    await this.db.insert(demoV2Artifacts).values({ ...value, engineVersion: 'v2' });
  }

  async insertTranslationPackage(
    value: TranslationInsert & { records?: unknown[] },
  ): Promise<void> {
    translationPackageSchema.parse({
      ...value,
      records: value.records ?? [],
      reviewActorType: value.reviewActorType ?? null,
      reviewActorId: value.reviewActorId ?? null,
      translationHash: value.translationHash ?? null,
    });
    const { records: _records, ...row } = value;
    await this.db.insert(demoV2TranslationPackages).values(row);
  }

  async recordAssetReuseReview(value: ReuseReviewInsert): Promise<void> {
    assetReuseReviewSchema.parse({
      id: value.id,
      assetSelectionId: value.assetSelectionId,
      decision: value.decision,
      actorType: value.actorType,
      actorId: value.actorId,
      boundAssetRecordHash: value.boundAssetRecordHash,
      boundSelectionHash: value.boundSelectionHash,
      reviewHash: value.reviewHash,
    });
    await this.db.insert(demoV2AssetReuseReviews).values(value);
  }

  async createApprovalPackage(
    value: ApprovalPackageInsert,
    screenshotSet: ScreenshotSet,
  ): Promise<void> {
    const parsed = approvalPackageSchema.parse(value);
    if (screenshotSetHash(screenshotSet) !== parsed.screenshotSetHash) {
      throw new Error('demo_v2_screenshot_set_hash_mismatch');
    }
    const { id: _id, approvalPackageHash, ...bindings } = parsed;
    if (computeApprovalPackageHash(bindings) !== approvalPackageHash) {
      throw new Error('demo_v2_approval_package_hash_mismatch');
    }
    await this.db.insert(demoV2ApprovalPackages).values(value);
  }

  async recordApprovalDecision(
    value: ApprovalDecisionInsert,
    requiredCategories: readonly string[],
  ): Promise<void> {
    const approval = (await this.db.select().from(demoV2ApprovalPackages)
      .where(eq(demoV2ApprovalPackages.id, value.approvalPackageId)).limit(1))[0];
    if (!approval) throw new Error('demo_v2_approval_package_missing');
    const decision: ApprovalDecision = approvalDecisionSchema.parse({
      decision: value.decision,
      actorType: value.actorType,
      actorId: value.actorId,
      reviewCycle: value.reviewCycle ?? null,
      score: value.score ?? null,
      blockerCount: value.blockerCount ?? null,
      categoryScores: value.categoryScores,
      boundApprovalPackageHash: value.boundApprovalPackageHash,
      boundVisualReviewSetHash: value.boundVisualReviewSetHash,
      boundQualityRubricHash: value.boundQualityRubricHash,
    });
    assertRequiredCategoryScores(decision, requiredCategories);
    assertDecisionBindings(decision, approvalPackageSchema.parse(approval));
    await this.db.insert(demoV2ApprovalDecisions).values(value);
  }

  async invalidateApproval(value: InvalidationInsert): Promise<void> {
    await this.db.insert(demoV2ApprovalInvalidations).values(value);
  }

  async approvalPackage(id: string) {
    return (await this.db.select().from(demoV2ApprovalPackages)
      .where(eq(demoV2ApprovalPackages.id, id)).limit(1))[0] ?? null;
  }
}
