import { desc, eq } from 'drizzle-orm';
import { type EmailDemoMeta } from '../../domain/email/email-render.js';
import { type DbExecutor } from '../db.js';
import { demos } from '../schema.js';

/** Reads the latest demo's metadata for a lead (id, lifecycle status, ctaKind). A demo_link
 * email is only permitted when this demo is human-APPROVED. */
export class EmailInputRepository {
  constructor(private readonly db: DbExecutor) {}

  async latestDemo(leadId: string): Promise<(EmailDemoMeta & { contentHash: string | null }) | null> {
    const rows = await this.db.select().from(demos).where(eq(demos.leadId, leadId)).orderBy(desc(demos.createdAt)).limit(1);
    const d = rows[0];
    if (!d) return null;
    const approvedFindingRefs = Array.isArray(d.findingRefs)
      ? d.findingRefs.filter((value): value is string => typeof value === 'string')
      : [];
    return {
      id: d.id,
      status: d.status,
      ctaKind: d.ctaKind,
      approvedFindingRefs,
      contentHash: d.contentHash,
    };
  }
}
