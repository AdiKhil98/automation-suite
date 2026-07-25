import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { assertDemoV2Transition, type DemoV2ArtifactStatus } from '../../domain/demo-v2/artifact-lifecycle.js';
import { type DbExecutor } from '../db.js';
import {
  demoV2Artifacts,
  demoV2RenderVersions,
  demoV2Screenshots,
  demoV2ReviewPackages,
} from '../schema.js';

/** The only artifact statuses Milestone 3B2A may set: the render → auto-review-pending path.
 * AUTO_REVIEW_PASSED and HUMAN_APPROVED are deliberately excluded (no real reviewer / approval). */
const RENDER_STATUSES = new Set<DemoV2ArtifactStatus>(['RENDERING', 'RENDERED', 'AUTO_REVIEW_PENDING']);

/**
 * Immutable, versioned persistence for Milestone 3A/3B1 render artifacts.
 *
 * Records are never mutated after finalization: a new render inserts a NEW version and marks the
 * previous one SUPERSEDED (history is retained). A changed render or screenshot set invalidates any
 * previous review eligibility because review packages bind the exact render + screenshot-set hash.
 * Nothing here can set HUMAN_APPROVED or make a render deployment eligible.
 */

export interface RenderVersionInput {
  artifactId: string;
  experiencePlanId: string;
  rendererVersion: string;
  referenceFamily: string;
  bundleLocation: string;
  primaryLanguage: string;
  supportedLanguages: readonly string[];
  intelligenceHash: string;
  contentHash: string;
  translationHash: string | null;
  assetSelectionSetHash: string;
  componentRegistryHash: string;
  referenceLibraryHash: string;
  creativeBriefHash: string;
  experiencePlanHash: string;
  renderHash: string;
  structurallyEligible: boolean;
  deterministicValidation: unknown;
}

export interface ScreenshotInput {
  kind: 'ORIGINAL' | 'FINAL';
  language: string;
  viewport: 'DESKTOP' | 'TABLET' | 'MOBILE';
  width: number;
  height: number;
  fileHash: string;
  location: string;
}

export interface ReviewPackageInput {
  schemaVersion: string;
  referenceFamily: string;
  rendererVersion: string;
  primaryLanguage: string;
  supportedLanguages: readonly string[];
  payload: unknown;
  renderHash: string;
  screenshotSetHash: string;
  reviewPackageHash: string;
  structurallyEligible: boolean;
}

export class DemoV2RenderRepository {
  constructor(private readonly db: DbExecutor) {}

  /** Insert a new immutable render version, superseding the prior current one for the artifact. */
  async persistRenderVersion(input: RenderVersionInput): Promise<{ id: string; version: number }> {
    const prior = await this.db.select({ id: demoV2RenderVersions.id, version: demoV2RenderVersions.version })
      .from(demoV2RenderVersions)
      .where(and(eq(demoV2RenderVersions.artifactId, input.artifactId), eq(demoV2RenderVersions.isCurrent, true)))
      .limit(1);
    const nextVersion = await this.nextVersion(input.artifactId);
    const id = randomUUID();
    // Retire the previous current row FIRST (partial-unique "one current per artifact").
    if (prior[0]) {
      await this.db.update(demoV2RenderVersions)
        .set({ isCurrent: false, status: 'SUPERSEDED', supersededById: id })
        .where(eq(demoV2RenderVersions.id, prior[0].id));
    }
    await this.db.insert(demoV2RenderVersions).values({
      id,
      artifactId: input.artifactId,
      experiencePlanId: input.experiencePlanId,
      version: nextVersion,
      rendererVersion: input.rendererVersion,
      referenceFamily: input.referenceFamily,
      bundleLocation: input.bundleLocation,
      status: 'RENDERED',
      primaryLanguage: input.primaryLanguage,
      supportedLanguages: [...input.supportedLanguages],
      intelligenceHash: input.intelligenceHash,
      contentHash: input.contentHash,
      translationHash: input.translationHash,
      assetSelectionSetHash: input.assetSelectionSetHash,
      componentRegistryHash: input.componentRegistryHash,
      referenceLibraryHash: input.referenceLibraryHash,
      creativeBriefHash: input.creativeBriefHash,
      experiencePlanHash: input.experiencePlanHash,
      renderHash: input.renderHash,
      structurallyEligible: input.structurallyEligible,
      deterministicValidation: input.deterministicValidation,
    });
    return { id, version: nextVersion };
  }

  async persistScreenshots(renderVersionId: string, rendererVersion: string, renderHash: string, screenshotSetHash: string, screenshots: readonly ScreenshotInput[]): Promise<void> {
    if (screenshots.length === 0) return;
    await this.db.insert(demoV2Screenshots).values(screenshots.map((shot) => ({
      id: randomUUID(),
      renderVersionId,
      kind: shot.kind,
      language: shot.language,
      viewport: shot.viewport,
      width: shot.width,
      height: shot.height,
      fileHash: shot.fileHash,
      location: shot.location,
      screenshotSetHash,
      rendererVersion,
      renderHash,
    })));
  }

  /**
   * Finalize a review package for a render version. Requires that all six required screenshots
   * (ORIGINAL + FINAL not enforced here beyond membership) exist and that the bound render/
   * screenshot-set hashes still match the persisted render version — a changed render invalidates
   * eligibility.
   */
  async persistReviewPackage(artifactId: string, renderVersionId: string, input: ReviewPackageInput): Promise<{ id: string }> {
    const version = (await this.db.select().from(demoV2RenderVersions).where(eq(demoV2RenderVersions.id, renderVersionId)).limit(1))[0];
    if (!version) throw new Error('demo_v2_review_package_render_version_missing');
    if (version.renderHash !== input.renderHash) throw new Error('demo_v2_review_package_stale_render');
    const shots = await this.db.select().from(demoV2Screenshots).where(eq(demoV2Screenshots.renderVersionId, renderVersionId));
    if (shots.some((shot) => shot.screenshotSetHash !== input.screenshotSetHash)) {
      throw new Error('demo_v2_review_package_stale_screenshot_set');
    }
    const required = version.supportedLanguages as string[];
    for (const language of required) {
      for (const viewport of ['DESKTOP', 'TABLET', 'MOBILE']) {
        if (!shots.some((shot) => shot.kind === 'FINAL' && shot.language === language && shot.viewport === viewport)) {
          throw new Error(`demo_v2_review_package_missing_screenshot:FINAL:${language}:${viewport}`);
        }
      }
    }
    for (const viewport of ['DESKTOP', 'TABLET', 'MOBILE']) {
      if (!shots.some((shot) => shot.kind === 'ORIGINAL' && shot.viewport === viewport)) {
        throw new Error(`demo_v2_review_package_missing_screenshot:ORIGINAL:${viewport}`);
      }
    }

    const prior = await this.db.select({ id: demoV2ReviewPackages.id }).from(demoV2ReviewPackages)
      .where(and(eq(demoV2ReviewPackages.artifactId, artifactId), eq(demoV2ReviewPackages.isCurrent, true))).limit(1);
    const id = randomUUID();
    if (prior[0]) {
      await this.db.update(demoV2ReviewPackages).set({ isCurrent: false }).where(eq(demoV2ReviewPackages.id, prior[0].id));
    }
    await this.db.insert(demoV2ReviewPackages).values({
      id,
      artifactId,
      renderVersionId,
      schemaVersion: input.schemaVersion,
      referenceFamily: input.referenceFamily,
      rendererVersion: input.rendererVersion,
      primaryLanguage: input.primaryLanguage,
      supportedLanguages: [...input.supportedLanguages],
      payload: input.payload,
      renderHash: input.renderHash,
      screenshotSetHash: input.screenshotSetHash,
      reviewPackageHash: input.reviewPackageHash,
      structurallyEligible: input.structurallyEligible,
      deploymentEligible: false,
    });
    return { id };
  }

  /** Advance the artifact through a 3B2A render status (RENDERING → RENDERED → AUTO_REVIEW_PENDING).
   * Any other target — including AUTO_REVIEW_PASSED / HUMAN_APPROVED — is refused. */
  async advanceArtifact(artifactId: string, to: DemoV2ArtifactStatus): Promise<void> {
    if (!RENDER_STATUSES.has(to)) throw new Error(`demo_v2_render_status_prohibited:${to}`);
    const current = (await this.db.select({ status: demoV2Artifacts.status }).from(demoV2Artifacts)
      .where(and(eq(demoV2Artifacts.id, artifactId), eq(demoV2Artifacts.isCurrent, true))).limit(1))[0];
    if (!current) throw new Error('demo_v2_artifact_missing');
    assertDemoV2Transition(current.status as DemoV2ArtifactStatus, to);
    await this.db.update(demoV2Artifacts).set({ status: to, updatedAt: new Date() }).where(eq(demoV2Artifacts.id, artifactId));
  }

  async currentRenderVersion(artifactId: string) {
    return (await this.db.select().from(demoV2RenderVersions)
      .where(and(eq(demoV2RenderVersions.artifactId, artifactId), eq(demoV2RenderVersions.isCurrent, true)))
      .limit(1))[0] ?? null;
  }

  async renderVersions(artifactId: string) {
    return this.db.select().from(demoV2RenderVersions)
      .where(eq(demoV2RenderVersions.artifactId, artifactId)).orderBy(desc(demoV2RenderVersions.version));
  }

  /** Recent render versions across artifacts (read-only inspection). */
  async recentRenderVersions(limit = 10) {
    return this.db.select().from(demoV2RenderVersions).orderBy(desc(demoV2RenderVersions.createdAt)).limit(limit);
  }

  async screenshotsForVersion(renderVersionId: string) {
    return this.db.select().from(demoV2Screenshots).where(eq(demoV2Screenshots.renderVersionId, renderVersionId));
  }

  async currentReviewPackage(artifactId: string) {
    return (await this.db.select().from(demoV2ReviewPackages)
      .where(and(eq(demoV2ReviewPackages.artifactId, artifactId), eq(demoV2ReviewPackages.isCurrent, true)))
      .limit(1))[0] ?? null;
  }

  async artifactStatus(artifactId: string): Promise<string | null> {
    return (await this.db.select({ status: demoV2Artifacts.status }).from(demoV2Artifacts)
      .where(eq(demoV2Artifacts.id, artifactId)).limit(1))[0]?.status ?? null;
  }

  private async nextVersion(artifactId: string): Promise<number> {
    const latest = await this.db.select({ version: demoV2RenderVersions.version })
      .from(demoV2RenderVersions).where(eq(demoV2RenderVersions.artifactId, artifactId))
      .orderBy(desc(demoV2RenderVersions.version)).limit(1);
    return (latest[0]?.version ?? 0) + 1;
  }
}
