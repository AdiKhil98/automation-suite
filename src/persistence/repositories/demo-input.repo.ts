import { and, desc, eq, inArray } from 'drizzle-orm';
import { type BriefFinding } from '../../domain/demo/demo-brief.js';
import { type AuditCategory } from '../../domain/audit/audit-types.js';
import { type DbExecutor } from '../db.js';
import { auditFindings, auditRuns, opportunityAssessments } from '../schema.js';

export interface DemoAuditInput {
  auditRunId: string;
  opportunityScore: number | null;
  findings: BriefFinding[];
}

/** Accepted finding enriched with the text the AI composer designs around. */
export interface ComposerAuditFinding {
  id: string;
  findingRef: string;
  category: AuditCategory;
  safeForOutreach: boolean;
  observation: string;
  recommendation: string;
}

export interface ComposerAuditInput {
  auditRunId: string;
  opportunityScore: number | null;
  findings: ComposerAuditFinding[];
}

/** Reads the Phase 6 outputs a demo needs: the latest AUDITED run's accepted findings
 * (real DB ids for relational provenance) + its opportunity score. */
export class DemoInputRepository {
  constructor(private readonly db: DbExecutor) {}

  async latestAudit(leadId: string): Promise<DemoAuditInput | null> {
    const runs = await this.db
      .select()
      .from(auditRuns)
      .where(and(eq(auditRuns.leadId, leadId), inArray(auditRuns.outcome, ['AUDITED', 'AUDITED_NO_ACTIONABLE_FINDINGS'])))
      .orderBy(desc(auditRuns.startedAt))
      .limit(1);
    const run = runs[0];
    if (!run) return null;

    const findingRows = await this.db.select().from(auditFindings).where(eq(auditFindings.auditRunId, run.id));
    const findings: BriefFinding[] = findingRows.map((f) => ({
      id: f.id,
      findingRef: f.findingRef,
      category: f.category as AuditCategory,
      safeForOutreach: f.safeForOutreach,
    }));

    const opp = await this.db.select().from(opportunityAssessments).where(eq(opportunityAssessments.auditRunId, run.id)).limit(1);
    return { auditRunId: run.id, opportunityScore: opp[0]?.overallScore ?? null, findings };
  }

  /** Like latestAudit but includes each finding's observation + recommendation text, which
   * the AI composer needs to design sections that address the finding. */
  async latestAuditForComposer(leadId: string): Promise<ComposerAuditInput | null> {
    const runs = await this.db
      .select()
      .from(auditRuns)
      .where(and(eq(auditRuns.leadId, leadId), inArray(auditRuns.outcome, ['AUDITED', 'AUDITED_NO_ACTIONABLE_FINDINGS'])))
      .orderBy(desc(auditRuns.startedAt))
      .limit(1);
    const run = runs[0];
    if (!run) return null;

    const findingRows = await this.db.select().from(auditFindings).where(eq(auditFindings.auditRunId, run.id));
    const findings: ComposerAuditFinding[] = findingRows.map((f) => ({
      id: f.id,
      findingRef: f.findingRef,
      category: f.category as AuditCategory,
      safeForOutreach: f.safeForOutreach,
      observation: f.observation,
      recommendation: f.recommendation,
    }));

    const opp = await this.db.select().from(opportunityAssessments).where(eq(opportunityAssessments.auditRunId, run.id)).limit(1);
    return { auditRunId: run.id, opportunityScore: opp[0]?.overallScore ?? null, findings };
  }
}
