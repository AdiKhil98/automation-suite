import { and, desc, eq, ne } from 'drizzle-orm';
import {
  type CompetitorResearchStore,
  type ExistingRunRef,
  type NewCompetitorCandidate,
  type NewCompetitorResearchRun,
} from '../../domain/competitor/research-service.js';
import { type DbExecutor } from '../db.js';
import { competitorCandidates, competitorResearchRuns } from '../schema.js';

/**
 * Phase 7A1 persistence for competitor research runs + candidates. Immutable/versioned: runs are
 * inserted, prior DRAFT runs for a lead are marked SUPERSEDED (never deleted), and identical
 * (lead,inputHash,configHash) reuses the existing run via the idempotency unique index.
 */
export class CompetitorResearchRepository implements CompetitorResearchStore {
  constructor(private readonly db: DbExecutor) {}

  async findRunByHashes(leadId: string, inputHash: string, configHash: string): Promise<ExistingRunRef | null> {
    const rows = await this.db
      .select({
        id: competitorResearchRuns.id,
        version: competitorResearchRuns.version,
        outcome: competitorResearchRuns.outcome,
        status: competitorResearchRuns.status,
      })
      .from(competitorResearchRuns)
      .where(
        and(
          eq(competitorResearchRuns.leadId, leadId),
          eq(competitorResearchRuns.inputHash, inputHash),
          eq(competitorResearchRuns.configHash, configHash),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async maxVersionForLead(leadId: string): Promise<number> {
    const rows = await this.db
      .select({ version: competitorResearchRuns.version })
      .from(competitorResearchRuns)
      .where(eq(competitorResearchRuns.leadId, leadId))
      .orderBy(desc(competitorResearchRuns.version))
      .limit(1);
    return rows[0]?.version ?? 0;
  }

  async supersedePriorDraftRuns(leadId: string, newRunId: string): Promise<void> {
    await this.db
      .update(competitorResearchRuns)
      .set({ status: 'SUPERSEDED', supersededBy: newRunId })
      .where(
        and(
          eq(competitorResearchRuns.leadId, leadId),
          eq(competitorResearchRuns.status, 'DRAFT'),
          ne(competitorResearchRuns.id, newRunId),
        ),
      );
  }

  async insertRun(run: NewCompetitorResearchRun): Promise<void> {
    await this.db.insert(competitorResearchRuns).values(run);
  }

  async insertCandidates(rows: NewCompetitorCandidate[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.insert(competitorCandidates).values(rows);
  }

  // --- read side (review CLI; not part of the write store port) ---

  async listRunsForLead(leadId: string): Promise<(typeof competitorResearchRuns.$inferSelect)[]> {
    return this.db
      .select()
      .from(competitorResearchRuns)
      .where(eq(competitorResearchRuns.leadId, leadId))
      .orderBy(desc(competitorResearchRuns.version));
  }

  async getCandidates(researchRunId: string): Promise<(typeof competitorCandidates.$inferSelect)[]> {
    return this.db
      .select()
      .from(competitorCandidates)
      .where(eq(competitorCandidates.researchRunId, researchRunId))
      .orderBy(competitorCandidates.rowIndex);
  }
}
