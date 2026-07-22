import { and, desc, eq, inArray } from 'drizzle-orm';
import { type EvidenceRef } from '../../domain/audit/evidence-package.js';
import { type DbExecutor } from '../db.js';
import { auditRuns, captureArtifacts, captureEvidence, capturedPages, modelCalls, websiteCaptureRuns } from '../schema.js';

export interface AuditValidationRepairSource {
  auditRunId: string;
  captureRunId: string;
  inputFingerprint: string;
  generatorRetryNumber: number;
  validationViolations: string[];
}

export interface AuditCaptureSource {
  captureRunId: string;
  primaryUrl: string | null;
  outcome: string;
  desktopPrimaryComplete: boolean;
  mobilePrimaryComplete: boolean;
  extractorVersion: string | null;
  emulationProfileVersion: string | null;
  pageSelectionPolicyVersion: string | null;
  evidence: EvidenceRef[];
  primaryViewportArtifacts: Array<{
    id: string;
    sha256: string;
    mime: string;
    profile: 'desktop' | 'mobile';
  }>;
}

/** Read-only queries that assemble the audit input from Phase-5 capture data.
 * Never returns full HTML or Google-derived context — evidence rows + primary
 * viewport screenshot metadata only. */
export class AuditInputRepository {
  constructor(private readonly db: DbExecutor) {}

  /** Latest usable AUDIT_CAPTURE run (CAPTURED or PARTIAL_CAPTURE) for a lead. */
  async latestAuditCapture(leadId: string): Promise<AuditCaptureSource | null> {
    const runs = await this.db
      .select()
      .from(websiteCaptureRuns)
      .where(and(eq(websiteCaptureRuns.leadId, leadId), eq(websiteCaptureRuns.purpose, 'AUDIT_CAPTURE'), inArray(websiteCaptureRuns.outcome, ['CAPTURED', 'PARTIAL_CAPTURE'])))
      .orderBy(desc(websiteCaptureRuns.startedAt))
      .limit(1);
    const run = runs[0];
    if (!run) return null;

    const pages = await this.db.select().from(capturedPages).where(eq(capturedPages.captureRunId, run.id));
    const pageById = new Map(pages.map((p) => [p.id, p]));
    const pageIds = pages.map((p) => p.id);
    if (pageIds.length === 0) return null;

    const evidenceRows = await this.db.select().from(captureEvidence).where(inArray(captureEvidence.capturedPageId, pageIds));
    const evidence: EvidenceRef[] = evidenceRows.map((e) => ({
      id: e.id,
      leadId,
      captureRunId: run.id,
      capturedPageId: e.capturedPageId,
      profile: e.profile as 'desktop' | 'mobile',
      evidenceType: e.evidenceType,
      sourceUrl: e.sourceUrl,
      extractedValue: e.extractedValue,
      normalizedValue: e.normalizedValue,
    }));

    // Primary-page viewport screenshots only (one desktop + one mobile) — bounds image input.
    const primaryPageIds = pages.filter((p) => p.role === 'primary' && p.ok).map((p) => p.id);
    const primaryViewportArtifacts: AuditCaptureSource['primaryViewportArtifacts'] = [];
    if (primaryPageIds.length > 0) {
      const arts = await this.db
        .select()
        .from(captureArtifacts)
        .where(and(inArray(captureArtifacts.capturedPageId, primaryPageIds), eq(captureArtifacts.kind, 'viewport')));
      const byProfile = new Set<string>();
      for (const a of arts) {
        if (byProfile.has(a.profile)) continue; // one per profile
        if (!pageById.has(a.capturedPageId)) continue;
        byProfile.add(a.profile);
        primaryViewportArtifacts.push({ id: a.id, sha256: a.sha256, mime: a.mime, profile: a.profile as 'desktop' | 'mobile' });
      }
    }

    return {
      captureRunId: run.id,
      primaryUrl: run.primaryUrl,
      outcome: run.outcome,
      desktopPrimaryComplete: run.desktopPrimaryComplete,
      mobilePrimaryComplete: run.mobilePrimaryComplete,
      extractorVersion: run.extractorVersion,
      emulationProfileVersion: run.emulationProfileVersion,
      pageSelectionPolicyVersion: run.pageSelectionPolicyVersion,
      evidence,
      primaryViewportArtifacts,
    };
  }

  /** A single attempt-0 validation failure eligible for exactly one bounded repair. */
  async latestValidationRepair(leadId: string): Promise<AuditValidationRepairSource | null> {
    const run = (await this.db.select().from(auditRuns)
      .where(and(eq(auditRuns.leadId, leadId), eq(auditRuns.outcome, 'VALIDATION_FAILED')))
      .orderBy(desc(auditRuns.startedAt)).limit(1))[0];
    if (!run) return null;
    const calls = await this.db.select().from(modelCalls).where(eq(modelCalls.auditRunId, run.id))
      .orderBy(modelCalls.createdAt);
    const generators = calls.filter((call) => call.purpose === 'website_audit');
    if (generators.length !== 1 || calls.some((call) => call.purpose === 'audit_review')) return null;
    const generator = generators[0];
    if (!generator || generator.retryNumber !== 0 || !run.inputFingerprint || !run.captureRunId) return null;
    const violations = Array.isArray(generator.validationViolations)
      ? generator.validationViolations.filter((item): item is string => typeof item === 'string')
      : [];
    if (violations.length === 0) return null;
    return {
      auditRunId: run.id,
      captureRunId: run.captureRunId,
      inputFingerprint: run.inputFingerprint,
      generatorRetryNumber: generator.retryNumber,
      validationViolations: violations,
    };
  }
}
