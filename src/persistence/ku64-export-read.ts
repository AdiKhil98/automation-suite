import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, inArray } from 'drizzle-orm';
import { readOnlyGuard } from '../domain/ku64-export/read-only-guard.js';
import {
  type Ku64ExportReadPort,
  type Ku64RawExportData,
} from '../domain/ku64-export/types.js';
import { type DbExecutor } from './db.js';
import * as schema from './schema.js';
import {
  auditFindingEvidence,
  auditFindings,
  auditReviewFindings,
  auditReviews,
  auditRuns,
  capturedPages,
  captureEvidence,
  evidence,
  leadFacts,
  leads,
  opportunityAssessments,
  qualificationResultFacts,
  qualificationResults,
  websiteCaptureRuns,
} from './schema.js';

/**
 * Open a connection pool whose every session is read-only at the server level via
 * the libpq `default_transaction_read_only=on` startup option. Any INSERT/UPDATE/
 * DELETE/DDL issued on such a connection is rejected by PostgreSQL itself, so this
 * is the authoritative write barrier; the {@link readOnlyGuard} proxy is defense
 * in depth on top of it.
 */
export function createReadOnlyDb(databaseUrl: string): { db: DbExecutor; pool: pg.Pool } {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    options: '-c default_transaction_read_only=on',
  });
  const db = drizzle(pool, { schema });
  return { db: readOnlyGuard(db), pool };
}

/** Whitelisted, read-only repository. Every method issues SELECT only. */
export class Ku64ExportReadRepository implements Ku64ExportReadPort {
  constructor(private readonly db: DbExecutor) {}

  async loadLeadExportData(leadId: string): Promise<Ku64RawExportData> {
    const leadRows = await this.db
      .select({
        id: leads.id,
        businessName: leads.businessName,
        normalizedName: leads.normalizedName,
        domain: leads.domain,
        normalizedDomain: leads.normalizedDomain,
        city: leads.city,
        country: leads.country,
        status: leads.status,
        factsSource: leads.factsSource,
        factsSourceUrl: leads.factsSourceUrl,
        factsCapturedAt: leads.factsCapturedAt,
      })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(2);

    // No lead → return an empty model; the pure builder decides the fail-closed path.
    if (leadRows.length === 0) {
      return emptyExportData();
    }

    const leadFactRows = await this.db
      .select({
        id: leadFacts.id,
        leadId: leadFacts.leadId,
        factType: leadFacts.factType,
        value: leadFacts.value,
        normalizedValue: leadFacts.normalizedValue,
        sourceType: leadFacts.sourceType,
        sourceUrl: leadFacts.sourceUrl,
        confidence: leadFacts.confidence,
        capturedAt: leadFacts.capturedAt,
        isCurrent: leadFacts.isCurrent,
      })
      .from(leadFacts)
      .where(eq(leadFacts.leadId, leadId));

    const qualificationResultRows = await this.db
      .select({
        id: qualificationResults.id,
        leadId: qualificationResults.leadId,
        campaign: qualificationResults.campaign,
        qualificationStage: qualificationResults.qualificationStage,
        rulesVersion: qualificationResults.rulesVersion,
        rulesConfigHash: qualificationResults.rulesConfigHash,
        decision: qualificationResults.decision,
        priority: qualificationResults.priority,
        nextStep: qualificationResults.nextStep,
        businessViabilityScore: qualificationResults.businessViabilityScore,
        auditabilityScore: qualificationResults.auditabilityScore,
        contactabilityScore: qualificationResults.contactabilityScore,
        opportunityScore: qualificationResults.opportunityScore,
        deterministicScore: qualificationResults.deterministicScore,
        triggeredRules: qualificationResults.triggeredRules,
        missingRequiredFacts: qualificationResults.missingRequiredFacts,
        reasons: qualificationResults.reasons,
        inputFingerprint: qualificationResults.inputFingerprint,
        evaluatedAt: qualificationResults.evaluatedAt,
      })
      .from(qualificationResults)
      .where(eq(qualificationResults.leadId, leadId));

    const qualificationResultFactRows = await this.selectIn(
      qualificationResultRows.map((q) => q.id),
      (ids) =>
        this.db
          .select({
            qualificationResultId: qualificationResultFacts.qualificationResultId,
            leadFactId: qualificationResultFacts.leadFactId,
          })
          .from(qualificationResultFacts)
          .where(inArray(qualificationResultFacts.qualificationResultId, ids)),
    );

    const captureRunRows = await this.db
      .select({
        id: websiteCaptureRuns.id,
        leadId: websiteCaptureRuns.leadId,
        purpose: websiteCaptureRuns.purpose,
        outcome: websiteCaptureRuns.outcome,
        primaryUrl: websiteCaptureRuns.primaryUrl,
        normalizedEvidenceFingerprint: websiteCaptureRuns.normalizedEvidenceFingerprint,
        extractorVersion: websiteCaptureRuns.extractorVersion,
        pageSelectionPolicyVersion: websiteCaptureRuns.pageSelectionPolicyVersion,
        startedAt: websiteCaptureRuns.startedAt,
        completedAt: websiteCaptureRuns.completedAt,
      })
      .from(websiteCaptureRuns)
      .where(eq(websiteCaptureRuns.leadId, leadId));

    const capturedPageRows = await this.selectIn(
      captureRunRows.map((c) => c.id),
      (ids) =>
        this.db
          .select({
            id: capturedPages.id,
            captureRunId: capturedPages.captureRunId,
            requestedUrl: capturedPages.requestedUrl,
            finalUrl: capturedPages.finalUrl,
            canonicalUrl: capturedPages.canonicalUrl,
            httpStatus: capturedPages.httpStatus,
            role: capturedPages.role,
            profile: capturedPages.profile,
            ok: capturedPages.ok,
            hasHorizontalOverflow: capturedPages.hasHorizontalOverflow,
          })
          .from(capturedPages)
          .where(inArray(capturedPages.captureRunId, ids)),
    );

    const captureEvidenceRows = await this.selectIn(
      capturedPageRows.map((p) => p.id),
      (ids) =>
        this.db
          .select({
            id: captureEvidence.id,
            capturedPageId: captureEvidence.capturedPageId,
            evidenceType: captureEvidence.evidenceType,
            sourceUrl: captureEvidence.sourceUrl,
            profile: captureEvidence.profile,
            selector: captureEvidence.selector,
            normalizedValue: captureEvidence.normalizedValue,
          })
          .from(captureEvidence)
          .where(inArray(captureEvidence.capturedPageId, ids)),
    );

    const auditRunRows = await this.db
      .select({
        id: auditRuns.id,
        leadId: auditRuns.leadId,
        captureRunId: auditRuns.captureRunId,
        outcome: auditRuns.outcome,
        rubricVersion: auditRuns.rubricVersion,
        generatorPromptVersion: auditRuns.generatorPromptVersion,
        reviewerPromptVersion: auditRuns.reviewerPromptVersion,
        schemaVersion: auditRuns.schemaVersion,
        opportunityRulesVersion: auditRuns.opportunityRulesVersion,
        opportunityRulesHash: auditRuns.opportunityRulesHash,
        inputFingerprint: auditRuns.inputFingerprint,
        startedAt: auditRuns.startedAt,
        completedAt: auditRuns.completedAt,
      })
      .from(auditRuns)
      .where(eq(auditRuns.leadId, leadId));

    const auditRunIds = auditRunRows.map((a) => a.id);

    const auditFindingRows = await this.selectIn(auditRunIds, (ids) =>
      this.db
        .select({
          id: auditFindings.id,
          auditRunId: auditFindings.auditRunId,
          findingRef: auditFindings.findingRef,
          category: auditFindings.category,
          observation: auditFindings.observation,
          affectedUrls: auditFindings.affectedUrls,
          affectedProfiles: auditFindings.affectedProfiles,
          severity: auditFindings.severity,
          confidence: auditFindings.confidence,
          businessImpact: auditFindings.businessImpact,
          recommendation: auditFindings.recommendation,
          safeForOutreach: auditFindings.safeForOutreach,
          outreachAngle: auditFindings.outreachAngle,
          uncertainty: auditFindings.uncertainty,
          reviewDecision: auditFindings.reviewDecision,
        })
        .from(auditFindings)
        .where(inArray(auditFindings.auditRunId, ids)),
    );

    const auditFindingEvidenceRows = await this.selectIn(
      auditFindingRows.map((f) => f.id),
      (ids) =>
        this.db
          .select({
            auditFindingId: auditFindingEvidence.auditFindingId,
            captureEvidenceId: auditFindingEvidence.captureEvidenceId,
          })
          .from(auditFindingEvidence)
          .where(inArray(auditFindingEvidence.auditFindingId, ids)),
    );

    const auditReviewRows = await this.selectIn(auditRunIds, (ids) =>
      this.db
        .select({
          id: auditReviews.id,
          auditRunId: auditReviews.auditRunId,
          overallDecision: auditReviews.overallDecision,
        })
        .from(auditReviews)
        .where(inArray(auditReviews.auditRunId, ids)),
    );

    const auditReviewFindingRows = await this.selectIn(
      auditReviewRows.map((r) => r.id),
      (ids) =>
        this.db
          .select({
            id: auditReviewFindings.id,
            auditReviewId: auditReviewFindings.auditReviewId,
            findingRef: auditReviewFindings.findingRef,
            decision: auditReviewFindings.decision,
            evidenceSupported: auditReviewFindings.evidenceSupported,
            impactSupported: auditReviewFindings.impactSupported,
            safeForOutreach: auditReviewFindings.safeForOutreach,
            problems: auditReviewFindings.problems,
            revisedObservation: auditReviewFindings.revisedObservation,
            revisedBusinessImpact: auditReviewFindings.revisedBusinessImpact,
            revisedRecommendation: auditReviewFindings.revisedRecommendation,
            revisedOutreachAngle: auditReviewFindings.revisedOutreachAngle,
          })
          .from(auditReviewFindings)
          .where(inArray(auditReviewFindings.auditReviewId, ids)),
    );

    const opportunityRows = await this.selectIn(auditRunIds, (ids) =>
      this.db
        .select({
          id: opportunityAssessments.id,
          auditRunId: opportunityAssessments.auditRunId,
          leadId: opportunityAssessments.leadId,
          conversionScore: opportunityAssessments.conversionScore,
          mobileScore: opportunityAssessments.mobileScore,
          trustScore: opportunityAssessments.trustScore,
          contactabilityScore: opportunityAssessments.contactabilityScore,
          overallScore: opportunityAssessments.overallScore,
          rulesVersion: opportunityAssessments.rulesVersion,
          rulesHash: opportunityAssessments.rulesHash,
          breakdown: opportunityAssessments.breakdown,
          capsApplied: opportunityAssessments.capsApplied,
        })
        .from(opportunityAssessments)
        .where(inArray(opportunityAssessments.auditRunId, ids)),
    );

    const evidenceRows = await this.db
      .select({
        id: evidence.id,
        leadId: evidence.leadId,
        sourceType: evidence.sourceType,
        sourceUrl: evidence.sourceUrl,
        claim: evidence.claim,
        confidence: evidence.confidence,
        selector: evidence.selector,
        capturedAt: evidence.capturedAt,
      })
      .from(evidence)
      .where(eq(evidence.leadId, leadId));

    return {
      leads: leadRows,
      leadFacts: leadFactRows,
      qualificationResults: qualificationResultRows,
      qualificationResultFacts: qualificationResultFactRows,
      auditRuns: auditRunRows,
      auditFindings: auditFindingRows,
      auditFindingEvidence: auditFindingEvidenceRows,
      auditReviews: auditReviewRows,
      auditReviewFindings: auditReviewFindingRows,
      opportunityAssessments: opportunityRows,
      evidence: evidenceRows,
      captureRuns: captureRunRows,
      capturedPages: capturedPageRows,
      captureEvidence: captureEvidenceRows,
    };
  }

  /** Run an `inArray` select only when there is at least one id; otherwise [] . */
  private async selectIn<R>(ids: readonly string[], run: (ids: string[]) => Promise<R[]>): Promise<R[]> {
    if (ids.length === 0) return [];
    return run([...ids]);
  }
}

function emptyExportData(): Ku64RawExportData {
  return {
    leads: [],
    leadFacts: [],
    qualificationResults: [],
    qualificationResultFacts: [],
    auditRuns: [],
    auditFindings: [],
    auditFindingEvidence: [],
    auditReviews: [],
    auditReviewFindings: [],
    opportunityAssessments: [],
    evidence: [],
    captureRuns: [],
    capturedPages: [],
    captureEvidence: [],
  };
}
