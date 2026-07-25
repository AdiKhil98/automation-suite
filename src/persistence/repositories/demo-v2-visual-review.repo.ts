import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { type DbExecutor } from '../db.js';
import {
  demoV2RenderVersions, demoV2ReviewPackages, demoV2VisualReviews,
} from '../schema.js';
import {
  visualReviewOutputHash, type VisualReviewResult,
} from '../../domain/demo-v2/render/visual-review.js';

/**
 * Immutable persistence for Sol visual reviews.
 *
 * A review row binds a verdict to the exact render / screenshot-set / review-package hashes and the
 * reviewer input fingerprint. Rows are never mutated after insertion except to flip `is_current`
 * (superseded by a later review) or `stale` (a bound hash changed). No method here can set
 * AUTO_REVIEW_PASSED, HUMAN_APPROVED, or make anything deployment eligible.
 */

export interface VisualReviewPersistInput {
  artifactId: string;
  renderVersionId: string;
  reviewPackageId: string;
  reviewRunId: string;
  cycle: number;
  inputFingerprint: string;
  boundRenderHash: string;
  boundScreenshotSetHash: string;
  boundReviewPackageHash: string;
  rubricVersion: string;
  rubricHash: string;
  result: VisualReviewResult;
}

export class DemoV2VisualReviewRepository {
  constructor(private readonly db: DbExecutor) {}

  /** Insert a new immutable review, superseding (is_current=false) the prior current one. */
  async persistReview(input: VisualReviewPersistInput): Promise<{ id: string; reviewOutputHash: string }> {
    if (input.result.decision === 'APPROVE' && input.result.blockers.length > 0) {
      throw new Error('demo_v2_visual_review_persist_inconsistent_decision');
    }
    // Fail closed: the bound render version + review package must still carry the bound hashes.
    const version = (await this.db.select().from(demoV2RenderVersions)
      .where(eq(demoV2RenderVersions.id, input.renderVersionId)).limit(1))[0];
    if (!version) throw new Error('demo_v2_visual_review_render_version_missing');
    if (version.renderHash !== input.boundRenderHash) throw new Error('demo_v2_visual_review_stale_render');

    const pkg = (await this.db.select().from(demoV2ReviewPackages)
      .where(eq(demoV2ReviewPackages.id, input.reviewPackageId)).limit(1))[0];
    if (!pkg) throw new Error('demo_v2_visual_review_package_missing');
    if (pkg.renderHash !== input.boundRenderHash
      || pkg.screenshotSetHash !== input.boundScreenshotSetHash
      || pkg.reviewPackageHash !== input.boundReviewPackageHash) {
      throw new Error('demo_v2_visual_review_stale_review_package');
    }

    const reviewOutputHash = visualReviewOutputHash(input.result);
    const prior = await this.db.select({ id: demoV2VisualReviews.id }).from(demoV2VisualReviews)
      .where(and(eq(demoV2VisualReviews.artifactId, input.artifactId), eq(demoV2VisualReviews.isCurrent, true))).limit(1);
    const id = randomUUID();
    if (prior[0]) {
      await this.db.update(demoV2VisualReviews).set({ isCurrent: false }).where(eq(demoV2VisualReviews.id, prior[0].id));
    }
    await this.db.insert(demoV2VisualReviews).values({
      id,
      artifactId: input.artifactId,
      renderVersionId: input.renderVersionId,
      reviewPackageId: input.reviewPackageId,
      reviewRunId: input.reviewRunId,
      cycle: input.cycle,
      provider: input.result.provider,
      requestedModel: input.result.requestedModel,
      resolvedModel: input.result.resolvedModel,
      reasoningEffort: input.result.reasoningEffort,
      schemaVersion: input.result.schemaVersion,
      inputFingerprint: input.inputFingerprint,
      boundRenderHash: input.boundRenderHash,
      boundScreenshotSetHash: input.boundScreenshotSetHash,
      boundReviewPackageHash: input.boundReviewPackageHash,
      rubricVersion: input.rubricVersion,
      rubricHash: input.rubricHash,
      overallScore: input.result.overallScore,
      categoryScores: input.result.scores,
      blockers: input.result.blockers,
      findings: input.result.findings,
      permittedRevisionOperations: input.result.permittedRevisionOperations,
      decision: input.result.decision,
      inputTokens: input.result.usage.inputTokens,
      cachedInputTokens: input.result.usage.cachedInputTokens,
      outputTokens: input.result.usage.outputTokens,
      reasoningTokens: input.result.usage.reasoningTokens,
      costUsd: input.result.costUsd.toFixed(6),
      responseId: input.result.responseId,
      reviewOutputHash,
    });
    return { id, reviewOutputHash };
  }

  /**
   * Mark every review whose bound render hash no longer matches the artifact's CURRENT render
   * version as stale. Called after a revision creates a new render version.
   */
  async markStaleReviews(artifactId: string): Promise<number> {
    const current = (await this.db.select({ renderHash: demoV2RenderVersions.renderHash }).from(demoV2RenderVersions)
      .where(and(eq(demoV2RenderVersions.artifactId, artifactId), eq(demoV2RenderVersions.isCurrent, true))).limit(1))[0];
    const reviews = await this.db.select().from(demoV2VisualReviews)
      .where(eq(demoV2VisualReviews.artifactId, artifactId));
    let staled = 0;
    for (const review of reviews) {
      if (review.stale) continue;
      if (!current || review.boundRenderHash !== current.renderHash) {
        await this.db.update(demoV2VisualReviews).set({ stale: true }).where(eq(demoV2VisualReviews.id, review.id));
        staled += 1;
      }
    }
    return staled;
  }

  /** Prior recorded reviewer spend for an artifact (used as the per-demo budget floor). */
  async priorSpendUsd(artifactId: string): Promise<number> {
    const reviews = await this.db.select({ costUsd: demoV2VisualReviews.costUsd }).from(demoV2VisualReviews)
      .where(eq(demoV2VisualReviews.artifactId, artifactId));
    const total = reviews.reduce((sum, row) => sum + Number(row.costUsd), 0);
    return Math.round(total * 1_000_000) / 1_000_000;
  }

  async reviewCountForRun(reviewRunId: string): Promise<number> {
    const rows = await this.db.select({ id: demoV2VisualReviews.id }).from(demoV2VisualReviews)
      .where(eq(demoV2VisualReviews.reviewRunId, reviewRunId));
    return rows.length;
  }

  async findByFingerprint(artifactId: string, inputFingerprint: string) {
    return (await this.db.select().from(demoV2VisualReviews)
      .where(and(eq(demoV2VisualReviews.artifactId, artifactId), eq(demoV2VisualReviews.inputFingerprint, inputFingerprint)))
      .limit(1))[0] ?? null;
  }

  async currentReview(artifactId: string) {
    return (await this.db.select().from(demoV2VisualReviews)
      .where(and(eq(demoV2VisualReviews.artifactId, artifactId), eq(demoV2VisualReviews.isCurrent, true))).limit(1))[0] ?? null;
  }

  async reviewHistory(artifactId: string) {
    return this.db.select().from(demoV2VisualReviews)
      .where(eq(demoV2VisualReviews.artifactId, artifactId)).orderBy(desc(demoV2VisualReviews.createdAt));
  }

  async recentReviews(limit = 10) {
    return this.db.select().from(demoV2VisualReviews).orderBy(desc(demoV2VisualReviews.createdAt)).limit(limit);
  }
}
