import { and, desc, eq, gte, notInArray, sql } from 'drizzle-orm';
import {
  type DeploymentRunRecord,
  type DeployStore,
  type FinalizationRecord,
} from '../../domain/deploy/deployment-service.js';
import { type DbExecutor } from '../db.js';
import { demoDeploymentRuns, emailDraftFinalizations } from '../schema.js';

type Row = typeof demoDeploymentRuns.$inferSelect;

function toRecord(r: Row): DeploymentRunRecord {
  return {
    id: r.id, leadId: r.leadId, demoId: r.demoId, originalEmailDraftId: r.originalEmailDraftId, provider: r.provider,
    siteId: r.siteId, deployId: r.deployId, artifactHash: r.artifactHash, attemptFingerprint: r.attemptFingerprint,
    outcome: r.outcome as DeploymentRunRecord['outcome'], draftUrl: r.draftUrl, permalinkUrl: r.permalinkUrl,
    verifiedUrl: r.verifiedUrl, verificationResult: r.verificationResult, errorClass: r.errorClass, callsMade: r.callsMade,
    startedAt: r.startedAt, completedAt: r.completedAt,
  };
}

/** Read + reserve side of the deployment store (outside the completion transaction). */
export class DeployRepository implements DeployStore {
  constructor(private readonly db: DbExecutor) {}

  async deployAttemptsToday(now: Date): Promise<number> {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const rows = await this.db.select({ n: sql<number>`count(*)::int` }).from(demoDeploymentRuns).where(gte(demoDeploymentRuns.startedAt, start));
    return rows[0]?.n ?? 0;
  }
  async lastAttemptAt(): Promise<Date | null> {
    const rows = await this.db.select().from(demoDeploymentRuns).orderBy(desc(demoDeploymentRuns.startedAt)).limit(1);
    return rows[0]?.startedAt ?? null;
  }
  async existingVerified(siteId: string, artifactHash: string): Promise<{ runId: string; deployId: string | null; verifiedUrl: string } | null> {
    const rows = await this.db.select().from(demoDeploymentRuns)
      .where(and(eq(demoDeploymentRuns.siteId, siteId), eq(demoDeploymentRuns.artifactHash, artifactHash), eq(demoDeploymentRuns.outcome, 'DEPLOYED_AND_VERIFIED')))
      .limit(1);
    const r = rows[0];
    return r?.verifiedUrl ? { runId: r.id, deployId: r.deployId, verifiedUrl: r.verifiedUrl } : null;
  }
  async findReservedByFingerprint(fingerprint: string): Promise<DeploymentRunRecord | null> {
    // Resume the latest NON-SUCCEEDED attempt for this fingerprint (pending, transient,
    // rate-limited, …). Reusing that row — and its deploy id — is how a retry reconciles an
    // uncertain prior outcome without creating a second deploy or violating the deploy-id UK.
    const rows = await this.db.select().from(demoDeploymentRuns)
      .where(and(eq(demoDeploymentRuns.attemptFingerprint, fingerprint), notInArray(demoDeploymentRuns.outcome, ['DEPLOYED_AND_VERIFIED', 'DUPLICATE_REUSED'])))
      .orderBy(desc(demoDeploymentRuns.startedAt)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }
  async reserveRun(row: DeploymentRunRecord): Promise<void> {
    await this.db.insert(demoDeploymentRuns).values({
      id: row.id, leadId: row.leadId, demoId: row.demoId, originalEmailDraftId: row.originalEmailDraftId, provider: row.provider,
      siteId: row.siteId, deployId: row.deployId, artifactHash: row.artifactHash, attemptFingerprint: row.attemptFingerprint,
      outcome: row.outcome, draftUrl: row.draftUrl, permalinkUrl: row.permalinkUrl, verifiedUrl: row.verifiedUrl,
      verificationResult: row.verificationResult, errorClass: row.errorClass, callsMade: row.callsMade, startedAt: row.startedAt, completedAt: row.completedAt,
    });
  }
  async setDeployId(runId: string, deployId: string): Promise<void> {
    await this.db.update(demoDeploymentRuns).set({ deployId }).where(eq(demoDeploymentRuns.id, runId));
  }
}

/** Transaction-scoped completion writes. */
export class DeployTxRepository {
  constructor(private readonly db: DbExecutor) {}

  async completeRun(runId: string, patch: Partial<DeploymentRunRecord>): Promise<void> {
    if (!runId) return;
    const set: Record<string, unknown> = {};
    if (patch.outcome !== undefined) set.outcome = patch.outcome;
    if (patch.deployId !== undefined) set.deployId = patch.deployId;
    if (patch.draftUrl !== undefined) set.draftUrl = patch.draftUrl;
    if (patch.permalinkUrl !== undefined) set.permalinkUrl = patch.permalinkUrl;
    if (patch.verifiedUrl !== undefined) set.verifiedUrl = patch.verifiedUrl;
    if (patch.verificationResult !== undefined) set.verificationResult = patch.verificationResult;
    if (patch.errorClass !== undefined) set.errorClass = patch.errorClass;
    if (patch.completedAt !== undefined) set.completedAt = patch.completedAt;
    if (Object.keys(set).length > 0) await this.db.update(demoDeploymentRuns).set(set).where(eq(demoDeploymentRuns.id, runId));
  }

  async createFinalization(row: FinalizationRecord): Promise<void> {
    // Idempotent: a finalization for (original_draft, deployment_run) is unique. A retry/reuse
    // that would re-create the identical record is a no-op rather than a duplicate-key error.
    await this.db.insert(emailDraftFinalizations).values({
      id: row.id, originalDraftId: row.originalDraftId, deploymentRunId: row.deploymentRunId, verifiedDeploymentUrl: row.verifiedDeploymentUrl,
      originalBodyHash: row.originalBodyHash, resolvedBody: row.resolvedBody, resolvedBodyHash: row.resolvedBodyHash,
    }).onConflictDoNothing({ target: [emailDraftFinalizations.originalDraftId, emailDraftFinalizations.deploymentRunId] });
  }
}
