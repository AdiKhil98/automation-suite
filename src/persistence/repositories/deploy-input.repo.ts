import { desc, eq } from 'drizzle-orm';
import { type DbExecutor } from '../db.js';
import { demos, emailDrafts } from '../schema.js';

export interface DeployInputData {
  demo: { id: string; status: string; contentHash: string | null; templateId: string; templateVersion: string } | null;
  email: { id: string; humanDecision: string | null; ctaKind: string; body: string } | null;
}

/** Gathers the latest demo + email for a lead to drive a deployment run. */
export class DeployInputRepository {
  constructor(private readonly db: DbExecutor) {}

  async latest(leadId: string): Promise<DeployInputData> {
    const d = (await this.db.select().from(demos).where(eq(demos.leadId, leadId)).orderBy(desc(demos.createdAt)).limit(1))[0];
    const e = (await this.db.select().from(emailDrafts).where(eq(emailDrafts.leadId, leadId)).orderBy(desc(emailDrafts.createdAt)).limit(1))[0];
    return {
      demo: d ? { id: d.id, status: d.status, contentHash: d.contentHash, templateId: d.templateId, templateVersion: d.templateVersion } : null,
      email: e ? { id: e.id, humanDecision: e.humanDecision, ctaKind: e.ctaKind, body: e.body } : null,
    };
  }
}
