import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt } from 'drizzle-orm';
import { CONTROLLED_TEST_ACTOR, CONTROLLED_TEST_OUTCOME, CONTROLLED_TEST_REASON,
  type ControlledArtifactType } from '../../domain/prospect/controlled-test.js';
import { type LocalSendReadinessReport } from '../../domain/send/send-service.js';
import { type DbExecutor } from '../db.js';
import { controlledTestArtifactApprovals, controlledTestEvaluations, controlledTestRuns,
  demos, emailDraftFinalizations, emailDrafts, gmailDrafts, sendSchedules } from '../schema.js';

export class ControlledTestRepository {
  constructor(private readonly db: DbExecutor) {}

  async start(input: { id: string; prospectRunId: string; pipelineRunId: string; leadId: string;
    recipientEmail: string; recipientFingerprint: string; recipientEnvName: string; expiresAt: Date }): Promise<void> {
    await this.db.insert(controlledTestRuns).values({ ...input, actor: CONTROLLED_TEST_ACTOR,
      reason: CONTROLLED_TEST_REASON, status: 'RUNNING', sendable: false });
  }

  async approve(input: { controlledTestRunId: string; leadId: string; artifactType: ControlledArtifactType;
    artifactId: string; artifactHash: string; recipientFingerprint: string; expiresAt: Date }): Promise<void> {
    await this.db.insert(controlledTestArtifactApprovals).values({ id: randomUUID(), ...input,
      actor: CONTROLLED_TEST_ACTOR, reason: CONTROLLED_TEST_REASON });
  }

  async hasApproval(input: { controlledTestRunId: string; leadId: string; artifactType: ControlledArtifactType;
    artifactId: string; artifactHash: string; recipientFingerprint: string; now?: Date }): Promise<boolean> {
    const rows = await this.db.select({ id: controlledTestArtifactApprovals.id }).from(controlledTestArtifactApprovals)
      .where(and(eq(controlledTestArtifactApprovals.controlledTestRunId, input.controlledTestRunId),
        eq(controlledTestArtifactApprovals.leadId, input.leadId), eq(controlledTestArtifactApprovals.artifactType, input.artifactType),
        eq(controlledTestArtifactApprovals.artifactId, input.artifactId), eq(controlledTestArtifactApprovals.artifactHash, input.artifactHash),
        eq(controlledTestArtifactApprovals.recipientFingerprint, input.recipientFingerprint),
        gt(controlledTestArtifactApprovals.expiresAt, input.now ?? new Date()))).limit(1);
    return rows.length === 1;
  }

  async isArtifactApproved(input: { controlledTestRunId: string; leadId: string; artifactType: ControlledArtifactType;
    artifactId: string; artifactHash: string; now?: Date }): Promise<boolean> {
    const run = (await this.db.select().from(controlledTestRuns)
      .where(and(eq(controlledTestRuns.id, input.controlledTestRunId), eq(controlledTestRuns.leadId, input.leadId),
        eq(controlledTestRuns.status, 'RUNNING'), eq(controlledTestRuns.sendable, false),
        gt(controlledTestRuns.expiresAt, input.now ?? new Date()))).limit(1))[0];
    if (!run) return false;
    return this.hasApproval({ ...input, recipientFingerprint: run.recipientFingerprint });
  }

  async latestDemo(leadId: string) {
    return (await this.db.select().from(demos).where(eq(demos.leadId, leadId)).orderBy(desc(demos.createdAt)).limit(1))[0] ?? null;
  }

  async latestEmail(leadId: string) {
    return (await this.db.select().from(emailDrafts).where(eq(emailDrafts.leadId, leadId)).orderBy(desc(emailDrafts.createdAt)).limit(1))[0] ?? null;
  }

  async latestFinalization(leadId: string) {
    return (await this.db.select({ finalization: emailDraftFinalizations, subject: emailDrafts.subject })
      .from(emailDraftFinalizations).innerJoin(emailDrafts, eq(emailDrafts.id, emailDraftFinalizations.originalDraftId))
      .where(eq(emailDrafts.leadId, leadId)).orderBy(desc(emailDraftFinalizations.finalizedAt)).limit(1))[0] ?? null;
  }

  async latestGmailDraft(leadId: string) {
    return (await this.db.select().from(gmailDrafts).where(eq(gmailDrafts.leadId, leadId))
      .orderBy(desc(gmailDrafts.createdAt)).limit(1))[0] ?? null;
  }

  async activeSchedule(leadId: string) {
    return (await this.db.select().from(sendSchedules).where(and(eq(sendSchedules.leadId, leadId),
      eq(sendSchedules.status, 'SCHEDULED'))).orderBy(desc(sendSchedules.createdAt)).limit(1))[0] ?? null;
  }

  async evaluation(input: { controlledTestRunId: string; leadId: string; gmailDraftId: string | null;
    scheduleId: string | null; evaluationType: 'READINESS' | 'DRY_RUN'; report: LocalSendReadinessReport }): Promise<void> {
    await this.db.insert(controlledTestEvaluations).values({ id: randomUUID(), ...input,
      outcome: CONTROLLED_TEST_OUTCOME, sendable: false });
  }

  async finish(id: string, status: 'COMPLETED' | 'FAILED'): Promise<void> {
    await this.db.update(controlledTestRuns).set({ status, completedAt: new Date() }).where(eq(controlledTestRuns.id, id));
  }
}
