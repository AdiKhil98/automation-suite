import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  type HumanDecision,
  type LeadReviewDetail,
  type LeadReviewSummary,
  type ReviewReadRepo,
  type ReviewWriteRepo,
} from '../../domain/review/review-service.js';
import { type DbExecutor } from '../db.js';
import { auditFindings, auditRuns, demos, emailDrafts, leadFacts, leads } from '../schema.js';

const AWAITING = ['READY_FOR_HUMAN_APPROVAL', 'WAITING_FOR_DEMO_URL'];

async function latestDemoRow(db: DbExecutor, leadId: string) {
  return (await db.select().from(demos).where(eq(demos.leadId, leadId)).orderBy(desc(demos.createdAt)).limit(1))[0];
}
async function latestEmailRow(db: DbExecutor, leadId: string) {
  return (await db.select().from(emailDrafts).where(eq(emailDrafts.leadId, leadId)).orderBy(desc(emailDrafts.createdAt)).limit(1))[0];
}

/** Read side of the review dashboard (outside the write transaction). */
export class ReviewReadRepository implements ReviewReadRepo {
  constructor(private readonly db: DbExecutor) {}

  async listAwaiting(): Promise<LeadReviewSummary[]> {
    const rows = await this.db.select().from(leads).where(inArray(leads.status, AWAITING)).orderBy(desc(leads.updatedAt));
    const out: LeadReviewSummary[] = [];
    for (const l of rows) {
      const demo = await latestDemoRow(this.db, l.id);
      const email = await latestEmailRow(this.db, l.id);
      out.push({
        leadId: l.id, businessName: l.businessName, leadStatus: l.status,
        demoStatus: demo?.status ?? null, emailHumanDecision: email?.humanDecision ?? null, hasEmail: !!email,
      });
    }
    return out;
  }

  async detail(leadId: string): Promise<LeadReviewDetail | null> {
    const l = (await this.db.select().from(leads).where(eq(leads.id, leadId)).limit(1))[0];
    if (!l) return null;

    const factRows = await this.db.select().from(leadFacts).where(and(eq(leadFacts.leadId, leadId), eq(leadFacts.isCurrent, true)));
    const facts = factRows.map((f) => ({ factType: f.factType, value: f.value }));

    const run = (await this.db.select().from(auditRuns)
      .where(and(eq(auditRuns.leadId, leadId), inArray(auditRuns.outcome, ['AUDITED', 'AUDITED_NO_ACTIONABLE_FINDINGS'])))
      .orderBy(desc(auditRuns.startedAt)).limit(1))[0];
    const findings = run
      ? (await this.db.select().from(auditFindings).where(eq(auditFindings.auditRunId, run.id)))
          .map((f) => ({ findingRef: f.findingRef, category: f.category, severity: f.severity, observation: f.observation, recommendation: f.recommendation }))
      : [];

    const d = await latestDemoRow(this.db, leadId);
    const e = await latestEmailRow(this.db, leadId);
    return {
      leadId, businessName: l.businessName, city: l.city, leadStatus: l.status, facts, findings,
      demo: d ? { id: d.id, status: d.status, path: d.path, approvedAt: d.approvedAt, approvedBy: d.approvedBy, approvalNotes: d.approvalNotes } : null,
      email: e ? { id: e.id, subject: e.subject, body: e.body, ctaKind: e.ctaKind, hasDemoUrlPlaceholder: e.hasDemoUrlPlaceholder, reviewerDecision: e.reviewerDecision, humanDecision: e.humanDecision, humanNotes: e.humanNotes } : null,
    };
  }
}

/** Transaction-scoped write side. */
export class ReviewWriteRepository implements ReviewWriteRepo {
  constructor(private readonly db: DbExecutor) {}

  async latestDemo(leadId: string): Promise<{ id: string; status: string } | null> {
    const d = await latestDemoRow(this.db, leadId);
    return d ? { id: d.id, status: d.status } : null;
  }
  async latestEmail(leadId: string): Promise<{ id: string; humanDecision: string | null } | null> {
    const e = await latestEmailRow(this.db, leadId);
    return e ? { id: e.id, humanDecision: e.humanDecision } : null;
  }
  async setDemoDecision(demoId: string, decision: HumanDecision, notes: string | null, actor: string, now: Date): Promise<void> {
    await this.db.update(demos).set({ status: decision, approvedAt: now, approvedBy: actor, approvalSource: 'dashboard', approvalNotes: notes }).where(eq(demos.id, demoId));
  }
  async setEmailHumanDecision(emailId: string, decision: HumanDecision, notes: string | null, actor: string, now: Date): Promise<void> {
    await this.db.update(emailDrafts).set({ humanDecision: decision, humanNotes: notes, humanReviewedAt: now, humanReviewedBy: actor }).where(eq(emailDrafts.id, emailId));
  }
}
