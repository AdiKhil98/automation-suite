import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { type AuditPersist, type AuditRunStore } from '../../domain/audit/audit-service.js';
import { type DbExecutor } from '../db.js';
import {
  auditFindingEvidence,
  auditFindings,
  auditReviewFindings,
  auditReviews,
  auditRuns,
  modelCalls,
  opportunityAssessments,
} from '../schema.js';

/** Persists a complete audit result. Every model call is recorded, even when the
 * outcome kept the lead in READY_FOR_AUDIT (no paid call disappears from history). */
export class AuditRepository implements AuditRunStore {
  constructor(private readonly db: DbExecutor) {}

  async exists(auditRunId: string): Promise<boolean> {
    const rows = await this.db.select({ id: auditRuns.id }).from(auditRuns).where(eq(auditRuns.id, auditRunId)).limit(1);
    return rows.length > 0;
  }

  async persist(record: AuditPersist): Promise<void> {
    const run = record.auditRun;
    await this.db.insert(auditRuns).values(run);

    for (const f of record.accepted) {
      await this.db.insert(auditFindings).values({
        id: f.id,
        auditRunId: run.id,
        findingRef: f.findingRef,
        category: f.category,
        observation: f.observation,
        affectedUrls: f.affectedUrls,
        affectedProfiles: f.affectedProfiles,
        severity: f.severity,
        confidence: f.confidence,
        businessImpact: f.businessImpact,
        recommendation: f.recommendation,
        safeForOutreach: f.safeForOutreach,
        outreachAngle: f.outreachAngle,
        uncertainty: f.uncertainty,
        reviewDecision: f.reviewDecision,
      });
      const uniqueEvidence = [...new Set(f.evidenceIds)];
      if (uniqueEvidence.length > 0) {
        await this.db.insert(auditFindingEvidence).values(
          uniqueEvidence.map((captureEvidenceId) => ({ auditFindingId: f.id, captureEvidenceId })),
        );
      }
    }

    if (record.reviews.length > 0) {
      const reviewId = randomUUID();
      await this.db.insert(auditReviews).values({ id: reviewId, auditRunId: run.id, overallDecision: 'APPROVE_WITH_REVISIONS' });
      await this.db.insert(auditReviewFindings).values(
        record.reviews.map((r) => ({
          id: randomUUID(),
          auditReviewId: reviewId,
          findingRef: r.findingRef,
          decision: r.decision,
          evidenceSupported: r.evidenceSupported,
          impactSupported: r.impactSupported,
          safeForOutreach: r.safeForOutreach,
          problems: r.problems,
          revisedObservation: r.revisedObservation,
          revisedBusinessImpact: r.revisedBusinessImpact,
          revisedRecommendation: r.revisedRecommendation,
          revisedOutreachAngle: r.revisedOutreachAngle,
        })),
      );
    }

    if (record.opportunity) {
      const o = record.opportunity;
      await this.db.insert(opportunityAssessments).values({
        id: randomUUID(),
        auditRunId: run.id,
        leadId: run.leadId,
        conversionScore: o.scores.conversion,
        mobileScore: o.scores.mobile,
        trustScore: o.scores.trust,
        contactabilityScore: o.scores.contactability,
        overallScore: o.scores.overall,
        rulesVersion: o.rulesVersion,
        rulesHash: o.rulesConfigHash,
        breakdown: o.breakdown,
        capsApplied: o.capsApplied,
      });
    }

    if (record.modelCalls.length > 0) {
      await this.db.insert(modelCalls).values(
        record.modelCalls.map((m) => ({ ...m, auditRunId: run.id, leadId: run.leadId })),
      );
    }
  }

  /**
   * The HIGHEST `overall_score` ever recorded for each lead (across every audit run, not just the
   * latest) — used by `contact-resolve-batch` to prioritize leads with the strongest existing audit
   * evidence first. A lead absent from the returned map has no opportunity assessment on record.
   */
  async maxOpportunityScores(leadIds: string[]): Promise<Map<string, number>> {
    if (leadIds.length === 0) return new Map();
    const rows = await this.db
      .select({ leadId: opportunityAssessments.leadId, overallScore: opportunityAssessments.overallScore })
      .from(opportunityAssessments)
      .where(inArray(opportunityAssessments.leadId, leadIds));
    const scores = new Map<string, number>();
    for (const row of rows) {
      const current = scores.get(row.leadId);
      if (current === undefined || row.overallScore > current) scores.set(row.leadId, row.overallScore);
    }
    return scores;
  }
}
