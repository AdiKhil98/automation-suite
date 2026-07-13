import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { type QualificationResult } from '../../domain/qualification/qualification-result.js';
import { type DbExecutor } from '../db.js';
import { qualificationResultFacts, qualificationResults } from '../schema.js';

/** Persists qualification results append-only, with the fact join rows. */
export class QualificationResultsRepository {
  constructor(private readonly db: DbExecutor) {}

  async save(result: QualificationResult): Promise<string> {
    const id = randomUUID();
    await this.db.insert(qualificationResults).values({
      id,
      leadId: result.leadId,
      campaign: result.campaign,
      qualificationStage: result.qualificationStage,
      rulesVersion: result.rulesVersion,
      rulesConfigHash: result.rulesConfigHash,
      evaluatedAt: result.evaluatedAt,
      businessViabilityScore: result.businessViabilityScore,
      auditabilityScore: result.auditabilityScore,
      contactabilityScore: result.contactabilityScore,
      opportunityScore: result.opportunityScore,
      deterministicScore: result.deterministicScore,
      decision: result.decision,
      priority: result.priority,
      nextStep: result.nextStep,
      triggeredRules: result.triggeredRules,
      missingRequiredFacts: result.missingRequiredFacts,
      reasons: result.reasons,
      inputFingerprint: result.inputFingerprint,
    });

    if (result.inputFactIds.length > 0) {
      await this.db.insert(qualificationResultFacts).values(
        result.inputFactIds.map((leadFactId) => ({
          qualificationResultId: id,
          leadFactId,
        })),
      );
    }
    return id;
  }

  async countByLead(leadId: string): Promise<number> {
    const rows = await this.db
      .select({ id: qualificationResults.id })
      .from(qualificationResults)
      .where(eq(qualificationResults.leadId, leadId));
    return rows.length;
  }

  async latestByLead(leadId: string): Promise<typeof qualificationResults.$inferSelect | null> {
    const rows = await this.db
      .select()
      .from(qualificationResults)
      .where(eq(qualificationResults.leadId, leadId))
      .orderBy(desc(qualificationResults.evaluatedAt))
      .limit(1);
    return rows[0] ?? null;
  }
}
