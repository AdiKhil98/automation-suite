import { and, desc, eq, ne } from 'drizzle-orm';
import {
  type CompetitorCaptureStore,
  type NewCompetitorCaptureRun,
  type NewCompetitorCapturedPage,
} from '../../domain/competitor/capture-service.js';
import { type CompetitorEvidenceItem } from '../../domain/competitor/evidence-types.js';
import { type DbExecutor } from '../db.js';
import {
  competitorCaptureRuns,
  competitorCapturedPages,
  competitorEvidenceItems,
} from '../schema.js';

/**
 * Phase 7A2 persistence for competitor capture runs + captured pages + evidence items.
 * Immutable/versioned: runs are inserted, prior DRAFT runs for a research run are marked SUPERSEDED
 * (never deleted), and identical (researchRunId, inputHash, configHash, contentHash) reuses the
 * existing run via the idempotency unique index. Evidence + pages are append-only. No raw HTML is
 * persisted (only a content hash). No email/Gmail/Sheets/sending path exists here.
 */
export class CompetitorCaptureRepository implements CompetitorCaptureStore {
  constructor(private readonly db: DbExecutor) {}

  async findRunByContent(
    researchRunId: string,
    inputHash: string,
    configHash: string,
    contentHash: string,
  ): Promise<{ id: string; version: number } | null> {
    const rows = await this.db
      .select({ id: competitorCaptureRuns.id, version: competitorCaptureRuns.version })
      .from(competitorCaptureRuns)
      .where(
        and(
          eq(competitorCaptureRuns.researchRunId, researchRunId),
          eq(competitorCaptureRuns.inputHash, inputHash),
          eq(competitorCaptureRuns.configHash, configHash),
          eq(competitorCaptureRuns.contentHash, contentHash),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async maxVersionForResearchRun(researchRunId: string): Promise<number> {
    const rows = await this.db
      .select({ version: competitorCaptureRuns.version })
      .from(competitorCaptureRuns)
      .where(eq(competitorCaptureRuns.researchRunId, researchRunId))
      .orderBy(desc(competitorCaptureRuns.version))
      .limit(1);
    return rows[0]?.version ?? 0;
  }

  async supersedePriorDraftRuns(researchRunId: string, newRunId: string): Promise<void> {
    await this.db
      .update(competitorCaptureRuns)
      .set({ status: 'SUPERSEDED', supersededBy: newRunId })
      .where(
        and(
          eq(competitorCaptureRuns.researchRunId, researchRunId),
          eq(competitorCaptureRuns.status, 'DRAFT'),
          ne(competitorCaptureRuns.id, newRunId),
        ),
      );
  }

  async insertRun(run: NewCompetitorCaptureRun): Promise<void> {
    await this.db.insert(competitorCaptureRuns).values(run);
  }

  async insertPages(rows: NewCompetitorCapturedPage[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.insert(competitorCapturedPages).values(rows);
  }

  async insertEvidence(rows: CompetitorEvidenceItem[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.insert(competitorEvidenceItems).values(
      rows.map((r) => ({
        id: r.id,
        captureRunId: r.captureRunId,
        competitorCandidateId: r.competitorCandidateId,
        evidenceCategory: r.evidenceCategory,
        observationKind: r.observationKind,
        observation: r.observation,
        sourcePageUrl: r.sourcePageUrl,
        normalizedOrigin: r.normalizedOrigin,
        selector: r.selector,
        sourceExcerpt: r.sourceExcerpt,
        profile: r.profile,
        numericValue: r.numericValue,
        confidence: r.confidence,
        freshnessStatus: r.freshnessStatus,
        withholdingReason: r.withholdingReason,
        safeForOutreach: r.safeForOutreach,
        active: r.active,
        captureMethod: r.captureMethod,
        provider: r.provider,
        rulesVersion: r.rulesVersion,
        capturedAt: r.capturedAt,
        evidenceHash: r.evidenceHash,
      })),
    );
  }

  // --- read side (review CLI; not part of the write store port) ---

  async listRunsForLead(leadId: string): Promise<(typeof competitorCaptureRuns.$inferSelect)[]> {
    return this.db
      .select()
      .from(competitorCaptureRuns)
      .where(eq(competitorCaptureRuns.leadId, leadId))
      .orderBy(desc(competitorCaptureRuns.version));
  }

  async getPages(captureRunId: string): Promise<(typeof competitorCapturedPages.$inferSelect)[]> {
    return this.db
      .select()
      .from(competitorCapturedPages)
      .where(eq(competitorCapturedPages.captureRunId, captureRunId));
  }

  async getEvidence(captureRunId: string): Promise<(typeof competitorEvidenceItems.$inferSelect)[]> {
    return this.db
      .select()
      .from(competitorEvidenceItems)
      .where(eq(competitorEvidenceItems.captureRunId, captureRunId))
      .orderBy(competitorEvidenceItems.competitorCandidateId);
  }

  /** Operator invalidation/supersession of an active evidence item (immutable history preserved). */
  async invalidateEvidence(evidenceId: string): Promise<boolean> {
    const rows = await this.db
      .update(competitorEvidenceItems)
      .set({ active: false, safeForOutreach: false, freshnessStatus: 'UNREPRODUCIBLE', withholdingReason: 'SOURCE_URL_UNREPRODUCIBLE' })
      .where(and(eq(competitorEvidenceItems.id, evidenceId), eq(competitorEvidenceItems.active, true)))
      .returning({ id: competitorEvidenceItems.id });
    return rows.length > 0;
  }
}
