import { randomUUID } from 'node:crypto';
import { type AddressInfo } from 'node:net';
import { request } from 'node:http';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { requireIntegrationTestDatabase } from '../support/test-database.js';
import { ReviewService } from '../../src/domain/review/review-service.js';
import { createReviewServer } from '../../src/dashboard/server.js';
import { buildCandidateLead } from '../../src/domain/leads/lead-factory.js';
import { type DbHandle } from '../../src/persistence/db.js';
import { DrizzleReviewUnitOfWork } from '../../src/persistence/review-unit-of-work.js';
import { ReviewReadRepository } from '../../src/persistence/repositories/review.repo.js';
import { LeadFactsRepository } from '../../src/persistence/repositories/lead-facts.repo.js';
import { LeadsRepository } from '../../src/persistence/repositories/leads.repo.js';
import { auditFindings, auditRuns, demoDecisions, demos, emailDrafts, leads as leadsTbl, pipelineEvents } from '../../src/persistence/schema.js';

const testDatabase = requireIntegrationTestDatabase();
const logger = pino({ level: 'silent' });

describe('review dashboard (PostgreSQL)', () => {
  let handle: DbHandle;
  beforeEach(async () => { handle ??= testDatabase.createHandle(); await testDatabase.truncate(handle.db); });
  afterAll(async () => { if (handle) await handle.pool.end(); });

  async function seed(opts: { leadStatus: string; placeholder?: boolean; sequenceStep?: number }): Promise<string> {
    const leads = new LeadsRepository(handle.db);
    const lead = buildCandidateLead({ sourcePlaceId: `p-${randomUUID()}`, source: 'mock' });
    await leads.create(lead);
    await handle.db.transaction(async (tx) => {
      const fr = new LeadFactsRepository(tx);
      await fr.writeCurrentFact({ leadId: lead.id, factType: 'business_name', value: 'Zahnärzte am Ufer', normalizedValue: 'z', sourceType: 'website', sourceUrl: null, confidence: 1 });
    });
    // Walk to the target state through legal transitions.
    for (const s of ['OPPORTUNITY_READY', 'DEMO_DECIDED', 'DEMO_READY', 'EMAIL_DRAFTED', 'EMAIL_APPROVED', opts.leadStatus])
      await leads.updateStatus(lead.id, s as never, new Date());

    const runId = randomUUID();
    await handle.db.insert(auditRuns).values({ id: runId, leadId: lead.id, outcome: 'AUDITED', rubricVersion: 'r', generatorPromptVersion: 'g', reviewerPromptVersion: 'rev', schemaVersion: 's', opportunityRulesVersion: 'opp', opportunityRulesHash: 'h', provider: 'mock', requestedAuditModel: 'm', reasoningEffort: 'medium', reasoningMode: 'standard', imageDetail: 'high', responseStore: false, inputFingerprint: 'fp', startedAt: new Date() });
    await handle.db.insert(auditFindings).values({ id: randomUUID(), auditRunId: runId, findingRef: 'F1', category: 'CTA_CLARITY', observation: 'o', affectedUrls: [], affectedProfiles: ['DESKTOP'], severity: 'MEDIUM', confidence: 0.8, businessImpact: 'i', recommendation: 'r', safeForOutreach: true, reviewDecision: 'APPROVE' });
    const decId = randomUUID();
    await handle.db.insert(demoDecisions).values({ id: decId, leadId: lead.id, decision: 'BUILD_DEMO', outcome: 'DEMO_COMPOSED', reason: 'seed', opportunityScore: 60, minOpportunity: 0, justifiedByScore: true, justifiedByFinding: true, briefRulesVersion: 'x' });
    await handle.db.insert(demos).values({ id: randomUUID(), leadId: lead.id, demoDecisionId: decId, templateId: 'composer-v1', templateVersion: 't', path: '/demos/seed', status: 'GENERATED_PENDING_REVIEW', noindexVerified: true, disclosurePresent: true, contentHash: 'h', ctaKind: 'scroll', factsUsed: [], findingRefs: [] });
    await handle.db.insert(emailDrafts).values({ id: randomUUID(), leadId: lead.id, runId: null, subject: 'Hi', body: 'Hallo,\n\nText', ctaKind: opts.placeholder ? 'demo_link' : 'reply', hasDemoUrlPlaceholder: !!opts.placeholder, status: 'APPROVED', writerPromptVersion: 'w', reviewerPromptVersion: 'r', schemaVersion: 's', rulesVersion: 'v', provider: 'mock', requestedWriterModel: 'm', requestedReviewerModel: 'm', reviewerDecision: 'APPROVE', totalCostUsd: 0, sequenceStep: opts.sequenceStep ?? 0 });
    return lead.id;
  }

  const service = () => new ReviewService({ uow: new DrizzleReviewUnitOfWork(handle.db), read: new ReviewReadRepository(handle.db), logger });

  it('approves demo (record only) and email (advances lead) independently', async () => {
    const leadId = await seed({ leadStatus: 'READY_FOR_HUMAN_APPROVAL' });
    expect(await service().decideDemo(leadId, 'APPROVED', 'nice')).toBe('DONE');
    expect(await service().decideEmail(leadId, 'APPROVED', 'send it')).toBe('DONE');

    const demo = (await handle.db.select().from(demos).where(eq(demos.leadId, leadId)))[0];
    expect(demo?.status).toBe('APPROVED');
    expect(demo?.approvedBy).toBe('local-reviewer');
    const email = (await handle.db.select().from(emailDrafts).where(eq(emailDrafts.leadId, leadId)))[0];
    expect(email?.humanDecision).toBe('APPROVED');
    expect((await handle.db.select().from(leadsTbl).where(eq(leadsTbl.id, leadId)))[0]?.status).toBe('HUMAN_APPROVED');
  });

  it('rejecting FOLLOW-UP copy returns the lead to SENT, against the real state machine', async () => {
    // PRODUCTION: this exact call threw InvalidStateTransitionError READY_FOR_HUMAN_APPROVAL -> SENT
    // and rolled back, so the operator could not reject the copy at all. The service was right; the
    // transition table was missing the edge its own documentation described.
    const leadId = await seed({ leadStatus: 'READY_FOR_HUMAN_APPROVAL', sequenceStep: 1 });

    expect(await service().decideEmail(leadId, 'REJECTED', 'restates the first email')).toBe('DONE');

    const email = (await handle.db.select().from(emailDrafts).where(eq(emailDrafts.leadId, leadId)))[0];
    expect(email?.humanDecision).toBe('REJECTED');
    expect(email?.humanReviewedAt).not.toBeNull();
    expect(email?.humanNotes).toBe('restates the first email');

    // The COPY was rejected; the prospect was not.
    const lead = (await handle.db.select().from(leadsTbl).where(eq(leadsTbl.id, leadId)))[0];
    expect(lead?.status).toBe('SENT');
    expect(lead?.status).not.toBe('REJECTED');

    // ...and the timeline says so.
    const events = await handle.db.select().from(pipelineEvents).where(eq(pipelineEvents.leadId, leadId));
    expect(events.some((e) => e.type === 'STATE_TRANSITION' && e.fromStatus === 'READY_FOR_HUMAN_APPROVAL' && e.toStatus === 'SENT')).toBe(true);
    expect(events.some((e) => (e.message ?? '').includes('lead returned to SENT, NOT rejected'))).toBe(true);
  });

  it('rejecting a FIRST email still rejects the lead', async () => {
    const leadId = await seed({ leadStatus: 'READY_FOR_HUMAN_APPROVAL', sequenceStep: 0 });

    expect(await service().decideEmail(leadId, 'REJECTED', 'not worth sending')).toBe('DONE');

    expect((await handle.db.select().from(leadsTbl).where(eq(leadsTbl.id, leadId)))[0]?.status).toBe('REJECTED');
  });

  it('the draft decision and the lead transition commit together', async () => {
    // Production proved the other half of this: when the transition threw, the whole transaction
    // rolled back and `human_decision` / `human_reviewed_at` stayed null rather than recording a
    // decision whose consequence never happened. (That rollback is pinned against an injected
    // failure in tests/unit/review-followup-rejection.test.ts, where the store can be made to fail.)
    // Here, through the real Drizzle unit of work, both halves land together — and a decision on a
    // lead that is no longer reviewable writes neither half.
    const leadId = await seed({ leadStatus: 'READY_FOR_HUMAN_APPROVAL', sequenceStep: 1 });

    expect(await service().decideEmail(leadId, 'REJECTED', 'restates the first email')).toBe('DONE');
    const committed = (await handle.db.select().from(emailDrafts).where(eq(emailDrafts.leadId, leadId)))[0];
    expect(committed?.humanDecision).toBe('REJECTED');
    expect(committed?.humanReviewedAt).not.toBeNull();
    expect((await handle.db.select().from(leadsTbl).where(eq(leadsTbl.id, leadId)))[0]?.status).toBe('SENT');

    // The lead is now SENT, which is not an email-reviewable state: nothing further is written.
    expect(await service().decideEmail(leadId, 'APPROVED', 'changed my mind')).toBe('INVALID_STATE');
    const after = (await handle.db.select().from(emailDrafts).where(eq(emailDrafts.leadId, leadId)))[0];
    expect(after?.humanDecision).toBe('REJECTED');
    expect(after?.humanNotes).toBe('restates the first email');
    expect(after?.humanReviewedAt?.getTime()).toBe(committed?.humanReviewedAt?.getTime());
    expect((await handle.db.select().from(leadsTbl).where(eq(leadsTbl.id, leadId)))[0]?.status).toBe('SENT');
  });

  it('WAITING_FOR_DEMO_URL: email approval records wording but keeps the lead waiting', async () => {
    const leadId = await seed({ leadStatus: 'WAITING_FOR_DEMO_URL', placeholder: true });
    expect(await service().decideEmail(leadId, 'APPROVED', null)).toBe('DONE');
    const email = (await handle.db.select().from(emailDrafts).where(eq(emailDrafts.leadId, leadId)))[0];
    expect(email?.humanDecision).toBe('APPROVED');
    expect((await handle.db.select().from(leadsTbl).where(eq(leadsTbl.id, leadId)))[0]?.status).toBe('WAITING_FOR_DEMO_URL');
  });

  it('loopback server: CSRF + same-origin + host checks; approve returns 303 and mutates', async () => {
    const leadId = await seed({ leadStatus: 'READY_FOR_HUMAN_APPROVAL' });
    const { server, csrfToken } = createReviewServer({ service: service(), demoOutputDir: './demos', logger });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const host = `127.0.0.1:${String(port)}`;

    const call = (opts: { method: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number }> =>
      new Promise((resolveCall, reject) => {
        const req = request({ host: '127.0.0.1', port, path: opts.path, method: opts.method, headers: { Host: host, ...opts.headers } }, (res) => { res.resume(); res.on('end', () => resolveCall({ status: res.statusCode ?? 0 })); });
        req.on('error', reject);
        if (opts.body) req.write(opts.body);
        req.end();
      });

    try {
      expect((await call({ method: 'GET', path: '/' })).status).toBe(200);
      expect((await call({ method: 'GET', path: `/lead/${leadId}` })).status).toBe(200);

      const form = (csrf: string) => `csrf=${csrf}&notes=ok`;
      const okHeaders = { Origin: `http://${host}`, 'Content-Type': 'application/x-www-form-urlencoded' };
      // bad host
      expect((await call({ method: 'POST', path: `/lead/${leadId}/demo/approve`, headers: { ...okHeaders, Host: 'evil.com' }, body: form(csrfToken) })).status).toBe(403);
      // bad origin
      expect((await call({ method: 'POST', path: `/lead/${leadId}/demo/approve`, headers: { ...okHeaders, Origin: 'http://evil.com' }, body: form(csrfToken) })).status).toBe(403);
      // bad csrf
      expect((await call({ method: 'POST', path: `/lead/${leadId}/demo/approve`, headers: okHeaders, body: form('wrong') })).status).toBe(403);
      // valid
      expect((await call({ method: 'POST', path: `/lead/${leadId}/demo/approve`, headers: okHeaders, body: form(csrfToken) })).status).toBe(303);

      expect((await handle.db.select().from(demos).where(eq(demos.leadId, leadId)))[0]?.status).toBe('APPROVED');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
