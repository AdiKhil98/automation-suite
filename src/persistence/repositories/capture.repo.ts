import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { type ArtifactMeta } from '../../integrations/capture/storage.js';
import { type CaptureEvidenceItem } from '../../domain/capture/capture-evidence.js';
import {
  type CaptureRunStore,
  type NewCaptureRun,
  type NewCapturedPage,
} from '../../domain/capture/capture-service.js';
import { type DbExecutor } from '../db.js';
import {
  captureArtifacts,
  captureErrors,
  captureEvidence,
  capturedPages,
  enrichmentAttempts,
  enrichmentCandidates,
  websiteCaptureRuns,
} from '../schema.js';

export class CaptureRepository implements CaptureRunStore {
  constructor(private readonly db: DbExecutor) {}

  async recordRun(run: NewCaptureRun): Promise<void> {
    await this.db.insert(websiteCaptureRuns).values({
      id: run.id,
      leadId: run.leadId,
      runId: run.runId,
      purpose: run.purpose,
      outcome: run.outcome,
      primaryUrl: run.primaryUrl,
      sourceEnrichmentCandidateId: run.sourceEnrichmentCandidateId,
      desktopPrimaryComplete: run.desktopPrimaryComplete,
      mobilePrimaryComplete: run.mobilePrimaryComplete,
      secondaryPagesAttempted: run.secondaryPagesAttempted,
      secondaryPagesCompleted: run.secondaryPagesCompleted,
      partialReason: run.partialReason,
      normalizedEvidenceFingerprint: run.normalizedEvidenceFingerprint,
      playwrightVersion: run.browser.playwrightVersion,
      browser: run.browser.browser,
      browserVersion: run.browser.browserVersion,
      chromiumRevision: run.browser.chromiumRevision,
      dockerImageTag: run.browser.dockerImageTag,
      emulationProfileVersion: run.emulationProfileVersion,
      pageSelectionPolicyVersion: run.pageSelectionPolicyVersion,
      extractorVersion: run.extractorVersion,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    });
  }

  async recordPage(captureRunId: string, page: NewCapturedPage): Promise<string> {
    const id = randomUUID();
    await this.db.insert(capturedPages).values({ id, captureRunId, ...page });
    return id;
  }

  async recordArtifact(capturedPageId: string, meta: ArtifactMeta): Promise<void> {
    await this.db.insert(captureArtifacts).values({
      id: randomUUID(),
      capturedPageId,
      sha256: meta.sha256,
      mime: meta.mime,
      bytes: meta.bytes,
      width: meta.width,
      height: meta.height,
      kind: meta.kind,
      profile: meta.profile,
    });
  }

  async recordEvidence(capturedPageId: string, items: CaptureEvidenceItem[]): Promise<void> {
    if (items.length === 0) return;
    await this.db.insert(captureEvidence).values(
      items.map((i) => ({
        id: randomUUID(),
        capturedPageId,
        evidenceType: i.evidenceType,
        sourceUrl: i.sourceUrl,
        profile: i.profile,
        selector: i.selector,
        extractedValue: i.extractedValue,
        normalizedValue: i.normalizedValue,
      })),
    );
  }

  async recordError(
    captureRunId: string,
    capturedPageId: string | null,
    err: { pageUrl: string | null; profile: 'desktop' | 'mobile' | null; kind: string; detail: string },
  ): Promise<void> {
    await this.db.insert(captureErrors).values({
      id: randomUUID(),
      captureRunId,
      capturedPageId,
      pageUrl: err.pageUrl,
      profile: err.profile,
      kind: err.kind,
      detail: err.detail,
    });
  }

  /** The exact Phase-4 BROWSER_REQUIRED candidate URL to re-render for verification. */
  async getVerificationTarget(leadId: string): Promise<{ url: string; candidateId: string } | null> {
    const rows = await this.db
      .select({ url: enrichmentCandidates.discoveredUrl, candidateId: enrichmentCandidates.id })
      .from(enrichmentAttempts)
      .innerJoin(enrichmentCandidates, eq(enrichmentCandidates.attemptId, enrichmentAttempts.id))
      .where(and(eq(enrichmentAttempts.leadId, leadId), eq(enrichmentAttempts.outcome, 'BROWSER_REQUIRED')))
      .orderBy(desc(enrichmentAttempts.startedAt))
      .limit(1);
    return rows[0] ?? null;
  }

  /** All artifact SHA-256 hashes referenced by committed capture runs (for GC). */
  async referencedArtifactShas(): Promise<Set<string>> {
    const rows = await this.db.select({ sha: captureArtifacts.sha256 }).from(captureArtifacts);
    return new Set(rows.map((r) => r.sha));
  }
}
