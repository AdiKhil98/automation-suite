import { desc, eq } from 'drizzle-orm';
import { type DbExecutor } from '../db.js';
import { controlledEmailArtifactHash } from '../../domain/prospect/controlled-test.js';
import { demos, emailDrafts } from '../schema.js';
import { ControlledTestRepository } from './controlled-test.repo.js';

export interface DeployInputData {
  demo: { id: string; status: string; contentHash: string | null; templateId: string; templateVersion: string } | null;
  email: { id: string; humanDecision: string | null; ctaKind: string; subject: string; body: string } | null;
}

/** Gathers the latest demo + email for a lead to drive a deployment run. */
export class DeployInputRepository {
  constructor(private readonly db: DbExecutor) {}

  async latest(leadId: string): Promise<DeployInputData> {
    const d = (await this.db.select().from(demos).where(eq(demos.leadId, leadId)).orderBy(desc(demos.createdAt)).limit(1))[0];
    const e = (await this.db.select().from(emailDrafts).where(eq(emailDrafts.leadId, leadId)).orderBy(desc(emailDrafts.createdAt)).limit(1))[0];
    return {
      demo: d ? { id: d.id, status: d.status, contentHash: d.contentHash, templateId: d.templateId, templateVersion: d.templateVersion } : null,
      email: e ? { id: e.id, humanDecision: e.humanDecision, ctaKind: e.ctaKind, subject: e.subject, body: e.body } : null,
    };
  }

  async controlledEligibility(controlledTestRunId: string, leadId: string, data: DeployInputData): Promise<{
    demo: NonNullable<DeployInputData['demo']>; email: NonNullable<DeployInputData['email']> } | null> {
    if (!data.demo?.contentHash || !data.email) return null;
    const approvals = new ControlledTestRepository(this.db);
    const demoApproved = await approvals.isArtifactApproved({ controlledTestRunId, leadId, artifactType: 'DEMO',
      artifactId: data.demo.id, artifactHash: data.demo.contentHash });
    const emailApproved = await approvals.isArtifactApproved({ controlledTestRunId, leadId, artifactType: 'EMAIL_DRAFT',
      artifactId: data.email.id, artifactHash: controlledEmailArtifactHash(data.email.subject, data.email.body) });
    if (!demoApproved || !emailApproved) throw new Error('controlled_test_deploy_approval_invalid');
    return { demo: { ...data.demo, status: 'APPROVED' }, email: { ...data.email, humanDecision: 'APPROVED' } };
  }
}
