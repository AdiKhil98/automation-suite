import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ScheduleService, type ScheduleConfig } from '../../src/domain/schedule/schedule-service.js';
import { type SchedulingRules } from '../../src/domain/schedule/scheduler.js';
import { buildCandidateLead } from '../../src/domain/leads/lead-factory.js';
import { createDb, type DbHandle } from '../../src/persistence/db.js';
import { DrizzleScheduleUnitOfWork } from '../../src/persistence/schedule-unit-of-work.js';
import { ScheduleRepository } from '../../src/persistence/repositories/schedule.repo.js';
import { ScheduleInputRepository } from '../../src/persistence/repositories/schedule-input.repo.js';
import { LeadFactsRepository } from '../../src/persistence/repositories/lead-facts.repo.js';
import { LeadsRepository } from '../../src/persistence/repositories/leads.repo.js';
import { PipelineRunsRepository } from '../../src/persistence/repositories/runs.repo.js';
import { truncateAll } from '../../src/persistence/maintenance.js';
import { demoDecisions, demoDeploymentRuns, demos, emailDraftFinalizations, emailDrafts, gmailDrafts, leads as leadsTbl, sendSchedules } from '../../src/persistence/schema.js';

const DATABASE_URL = process.env.DATABASE_URL;
const logger = pino({ level: 'silent' });
const TZ = 'America/New_York';
const RECIP = 'contact@example.com';
const MON = Date.parse('2026-07-20T00:00:00Z');
const rules: SchedulingRules = { windowStartHour: 9, windowEndHour: 17, allowedWeekdays: [1, 2, 3, 4, 5], minSpacingMinutes: 30, dailyCap: 20, earliestOffsetMinutes: 60, horizonDays: 14 };
const cfg: ScheduleConfig = { featureEnabled: true, rules, rulesVersion: 'sched-rules-1' };

describe.skipIf(!DATABASE_URL)('scheduling (PostgreSQL)', () => {
  let handle: DbHandle;
  beforeEach(async () => { handle ??= createDb(DATABASE_URL as string); await truncateAll(handle.db); });
  afterAll(async () => { if (handle) await handle.pool.end(); });

  async function seed(): Promise<string> {
    const leads = new LeadsRepository(handle.db);
    const lead = buildCandidateLead({ sourcePlaceId: `p-${randomUUID()}`, source: 'mock' });
    await leads.create(lead);
    await handle.db.transaction(async (tx) => {
      const fr = new LeadFactsRepository(tx);
      await fr.writeCurrentFact({ leadId: lead.id, factType: 'contact_email', value: RECIP, normalizedValue: RECIP, sourceType: 'website', sourceUrl: null, confidence: 1 });
      await fr.writeCurrentFact({ leadId: lead.id, factType: 'contact_timezone', value: TZ, normalizedValue: TZ.toLowerCase(), sourceType: 'website', sourceUrl: null, confidence: 1 });
    });
    for (const s of ['OPPORTUNITY_READY', 'DEMO_DECIDED', 'DEMO_READY', 'EMAIL_DRAFTED', 'EMAIL_APPROVED', 'WAITING_FOR_DEMO_URL', 'FINALIZED_EMAIL_PENDING', 'HUMAN_APPROVED', 'DRAFT_CREATED'])
      await leads.updateStatus(lead.id, s as never, new Date());
    const decId = randomUUID(), demoId = randomUUID(), emailId = randomUUID(), depId = randomUUID(), gId = randomUUID();
    await handle.db.insert(demoDecisions).values({ id: decId, leadId: lead.id, decision: 'BUILD_DEMO', outcome: 'DEMO_COMPOSED', reason: 'seed', opportunityScore: 60, minOpportunity: 0, justifiedByScore: true, justifiedByFinding: true, briefRulesVersion: 'x' });
    await handle.db.insert(demos).values({ id: demoId, leadId: lead.id, demoDecisionId: decId, templateId: 'composer-v1', templateVersion: 't', path: '/demos/seed', status: 'APPROVED', noindexVerified: true, disclosurePresent: true, contentHash: 'h', ctaKind: 'scroll', factsUsed: [], findingRefs: [] });
    await handle.db.insert(emailDrafts).values({ id: emailId, leadId: lead.id, runId: null, subject: 'Note', body: 'Hallo, {{SENDER_NAME}}', ctaKind: 'demo_link', hasDemoUrlPlaceholder: true, status: 'APPROVED', writerPromptVersion: 'w', reviewerPromptVersion: 'r', schemaVersion: 's', rulesVersion: 'v', provider: 'mock', requestedWriterModel: 'm', requestedReviewerModel: 'm', reviewerDecision: 'APPROVE', humanDecision: 'APPROVED', totalCostUsd: 0 });
    await handle.db.insert(demoDeploymentRuns).values({ id: depId, leadId: lead.id, demoId, originalEmailDraftId: emailId, provider: 'http-netlify', siteId: 's', deployId: 'd1', artifactHash: 'h', attemptFingerprint: 'fp', outcome: 'DEPLOYED_AND_VERIFIED', draftUrl: 'https://x', verifiedUrl: 'https://x', callsMade: 0, startedAt: new Date(), completedAt: new Date() });
    await handle.db.insert(emailDraftFinalizations).values({ id: randomUUID(), originalDraftId: emailId, deploymentRunId: depId, verifiedDeploymentUrl: 'https://x--example.netlify.app/', originalBodyHash: 'oh', resolvedBody: 'Hallo, {{SENDER_NAME}}', resolvedBodyHash: 'contenthash1', finalHumanDecision: 'APPROVED' });
    await handle.db.insert(gmailDrafts).values({ id: gId, leadId: lead.id, finalizedEmailId: null, recipientEmail: RECIP, senderEmail: 'me@example.com', gmailAccount: 'me@example.com', provider: 'mock-gmail', providerDraftId: 'draft-xyz', threadId: 'thread-1', messageId: 'msg-1', idempotencyFingerprint: 'gfp', sourceEmailVersion: 'contenthash1', outcome: 'DRAFT_CREATED', createdAt: new Date(), completedAt: new Date() });
    return lead.id;
  }

  const service = () => new ScheduleService({ store: new ScheduleRepository(handle.db), uow: new DrizzleScheduleUnitOfWork(handle.db), logger, config: cfg, now: () => MON });
  const input = async (leadId: string, leadStatus: string) => {
    const d = await new ScheduleInputRepository(handle.db).latest(leadId);
    return { leadId, leadStatus, gmailDraft: d.gmailDraft, finalizedContentHash: d.finalizedContentHash, recipientEmail: d.recipientEmail, timezone: d.timezone };
  };

  it('schedules (DRAFT_CREATED→SCHEDULED), enforces one active, then cancels (→DRAFT_CREATED, history kept)', async () => {
    const leadId = await seed();
    const runs = new PipelineRunsRepository(handle.db);
    const r = await service().schedule(await input(leadId, 'DRAFT_CREATED'), await runs.start('sched:1', true));
    expect(r.outcome).toBe('SCHEDULED');

    const rows = await handle.db.select().from(sendSchedules).where(eq(sendSchedules.leadId, leadId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('SCHEDULED');
    expect(rows[0]?.finalizedContentHash).toBe('contenthash1');
    expect(rows[0]?.providerDraftId).toBe('draft-xyz');
    expect(rows[0]?.integrityFingerprint).toBeTruthy();
    expect((await handle.db.select().from(leadsTbl).where(eq(leadsTbl.id, leadId)))[0]?.status).toBe('SCHEDULED');

    // Reuse (one active per draft): lead reset to DRAFT_CREATED, existing active schedule reused.
    await new LeadsRepository(handle.db).updateStatus(leadId, 'DRAFT_CREATED', new Date());
    const r2 = await service().schedule(await input(leadId, 'DRAFT_CREATED'), await runs.start('sched:2', true));
    expect(r2.outcome).toBe('DUPLICATE_REUSED');
    expect(await handle.db.select().from(sendSchedules).where(eq(sendSchedules.leadId, leadId))).toHaveLength(1);

    // Cancel: row retained as CANCELLED, lead back to DRAFT_CREATED.
    await new LeadsRepository(handle.db).updateStatus(leadId, 'SCHEDULED', new Date());
    const c = await service().cancel(leadId, 'operator changed mind', await runs.start('sched:3', true));
    expect(c.outcome).toBe('CANCELLED');
    const after = await handle.db.select().from(sendSchedules).where(eq(sendSchedules.leadId, leadId));
    expect(after).toHaveLength(1);
    expect(after[0]?.status).toBe('CANCELLED');
    expect(after[0]?.cancelReason).toBe('operator changed mind');
    expect((await handle.db.select().from(leadsTbl).where(eq(leadsTbl.id, leadId)))[0]?.status).toBe('DRAFT_CREATED');
  });

  it('reschedule supersedes the old row and inserts a new active one (history preserved)', async () => {
    const leadId = await seed();
    const runs = new PipelineRunsRepository(handle.db);
    await service().schedule(await input(leadId, 'DRAFT_CREATED'), await runs.start('sched:a', true));
    const r = await service().reschedule(await input(leadId, 'SCHEDULED'), '2026-07-21T14:00:00Z', await runs.start('sched:b', true));
    expect(r.outcome).toBe('RESCHEDULED');
    const rows = await handle.db.select().from(sendSchedules).where(eq(sendSchedules.leadId, leadId));
    expect(rows).toHaveLength(2);
    expect(rows.filter((x) => x.status === 'SCHEDULED')).toHaveLength(1);
    expect(rows.filter((x) => x.status === 'SUPERSEDED')).toHaveLength(1);
    const active = rows.find((x) => x.status === 'SCHEDULED');
    expect(active?.rescheduleCount).toBe(1);
    expect(active?.scheduledAtUtc.toISOString()).toBe('2026-07-21T14:00:00.000Z');
  });
});
