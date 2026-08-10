import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { type CaptureEvidenceType } from '../../domain/capture/capture-evidence.js';
import { type AuditCategory } from '../../domain/audit/audit-types.js';
import {
  type ApprovedDeterministicFinding,
  type DeterministicCaptureRunRef,
  type DeterministicComposerFinding,
  type DeterministicEvidenceRow,
} from '../../domain/deterministic-finding/types.js';
import { type DbExecutor } from '../db.js';
import {
  captureEvidence,
  capturedPages,
  deterministicFindingEvidence,
  deterministicFindings,
  websiteCaptureRuns,
} from '../schema.js';

/**
 * Persistence for deterministic outreach findings. Reads the capture evidence an operator cites (with
 * lead/run ownership resolved) and, on approval, writes the finding + its evidence links. It NEVER
 * reads or writes any audit_runs / audit_findings row — AI audit history is untouched.
 */
export class DeterministicFindingRepository {
  constructor(private readonly db: DbExecutor) {}

  /** Latest completed capture run for the lead (the run a deterministic finding is evaluated against). */
  async latestCaptureRun(leadId: string): Promise<DeterministicCaptureRunRef | null> {
    const rows = await this.db
      .select({
        id: websiteCaptureRuns.id,
        completedAt: websiteCaptureRuns.completedAt,
        pageSelectionPolicyVersion: websiteCaptureRuns.pageSelectionPolicyVersion,
      })
      .from(websiteCaptureRuns)
      .where(and(eq(websiteCaptureRuns.leadId, leadId), isNotNull(websiteCaptureRuns.completedAt)))
      .orderBy(desc(websiteCaptureRuns.startedAt))
      .limit(1);
    const run = rows[0];
    if (!run || !run.completedAt) return null;
    return { id: run.id, completedAt: run.completedAt, pageSelectionPolicyVersion: run.pageSelectionPolicyVersion };
  }

  /** Resolve the cited evidence ids to rows with lead/run ownership (missing ids are simply absent). */
  async loadCitedEvidence(evidenceIds: string[]): Promise<DeterministicEvidenceRow[]> {
    if (evidenceIds.length === 0) return [];
    const rows = await this.db
      .select({
        id: captureEvidence.id,
        leadId: websiteCaptureRuns.leadId,
        captureRunId: capturedPages.captureRunId,
        evidenceType: captureEvidence.evidenceType,
        sourceUrl: captureEvidence.sourceUrl,
        profile: captureEvidence.profile,
        extractedValue: captureEvidence.extractedValue,
        normalizedValue: captureEvidence.normalizedValue,
      })
      .from(captureEvidence)
      .innerJoin(capturedPages, eq(capturedPages.id, captureEvidence.capturedPageId))
      .innerJoin(websiteCaptureRuns, eq(websiteCaptureRuns.id, capturedPages.captureRunId))
      .where(inArray(captureEvidence.id, evidenceIds));
    return rows.map(mapEvidenceRow);
  }

  /** All evidence rows for a capture run (used for the direct-booking-signal absence scan). */
  async loadRunEvidence(captureRunId: string): Promise<DeterministicEvidenceRow[]> {
    const rows = await this.db
      .select({
        id: captureEvidence.id,
        leadId: websiteCaptureRuns.leadId,
        captureRunId: capturedPages.captureRunId,
        evidenceType: captureEvidence.evidenceType,
        sourceUrl: captureEvidence.sourceUrl,
        profile: captureEvidence.profile,
        extractedValue: captureEvidence.extractedValue,
        normalizedValue: captureEvidence.normalizedValue,
      })
      .from(captureEvidence)
      .innerJoin(capturedPages, eq(capturedPages.id, captureEvidence.capturedPageId))
      .innerJoin(websiteCaptureRuns, eq(websiteCaptureRuns.id, capturedPages.captureRunId))
      .where(eq(capturedPages.captureRunId, captureRunId));
    return rows.map(mapEvidenceRow);
  }

  /** Categories of the lead's currently-ACTIVE deterministic findings (for duplicate prevention). */
  async listActiveCategories(leadId: string): Promise<string[]> {
    const rows = await this.db
      .select({ category: deterministicFindings.category })
      .from(deterministicFindings)
      .where(and(eq(deterministicFindings.leadId, leadId), eq(deterministicFindings.status, 'ACTIVE')));
    return rows.map((r) => r.category);
  }

  /** Insert an approved finding plus its evidence links. Must run inside the approval transaction. */
  async insertApproved(finding: ApprovedDeterministicFinding): Promise<void> {
    await this.db.insert(deterministicFindings).values({
      id: finding.id,
      leadId: finding.leadId,
      captureRunId: finding.captureRunId,
      category: finding.category,
      findingRef: finding.findingRef,
      observation: finding.observation,
      recommendation: finding.recommendation,
      safeForOutreach: finding.safeForOutreach,
      status: finding.status,
      provenance: finding.provenance,
      approvedBy: finding.approvedBy,
      approvedAt: finding.approvedAt,
      templateVersion: finding.templateVersion,
      rulesVersion: finding.rulesVersion,
      evidenceHash: finding.evidenceHash,
    });
    const uniqueEvidence = [...new Set(finding.evidenceIds)];
    if (uniqueEvidence.length > 0) {
      await this.db.insert(deterministicFindingEvidence).values(
        uniqueEvidence.map((captureEvidenceId) => ({ deterministicFindingId: finding.id, captureEvidenceId })),
      );
    }
  }

  /** Project the lead's ACTIVE deterministic findings into the composer's finding shape. */
  async listActiveComposerFindings(leadId: string): Promise<DeterministicComposerFinding[]> {
    const rows = await this.db
      .select({
        id: deterministicFindings.id,
        findingRef: deterministicFindings.findingRef,
        category: deterministicFindings.category,
        safeForOutreach: deterministicFindings.safeForOutreach,
        observation: deterministicFindings.observation,
        recommendation: deterministicFindings.recommendation,
      })
      .from(deterministicFindings)
      .where(and(eq(deterministicFindings.leadId, leadId), eq(deterministicFindings.status, 'ACTIVE')))
      .orderBy(desc(deterministicFindings.approvedAt));
    return rows.map((r) => ({
      id: r.id,
      findingRef: r.findingRef,
      category: r.category as AuditCategory,
      safeForOutreach: r.safeForOutreach,
      observation: r.observation,
      recommendation: r.recommendation,
    }));
  }
}

function mapEvidenceRow(r: {
  id: string;
  leadId: string;
  captureRunId: string;
  evidenceType: string;
  sourceUrl: string | null;
  profile: string;
  extractedValue: string | null;
  normalizedValue: string | null;
}): DeterministicEvidenceRow {
  return {
    id: r.id,
    leadId: r.leadId,
    captureRunId: r.captureRunId,
    evidenceType: r.evidenceType as CaptureEvidenceType,
    sourceUrl: r.sourceUrl,
    profile: r.profile as 'desktop' | 'mobile',
    extractedValue: r.extractedValue,
    normalizedValue: r.normalizedValue,
  };
}
