import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { EmailWriterService } from '../../src/domain/email/email-writer-service.js';
import { worstCaseEmailInputTokens } from '../../src/domain/email/email-token-budget.js';
import { buildCandidateLead } from '../../src/domain/leads/lead-factory.js';
import { defaultMockEmailResponder } from '../../src/fixtures/mock-email-responses.js';
import { MockLlmProvider } from '../../src/integrations/llm/mock-llm.js';
import { createDb, type DbHandle } from '../../src/persistence/db.js';
import { DrizzleEmailUnitOfWork } from '../../src/persistence/email-unit-of-work.js';
import { truncateAll } from '../../src/persistence/maintenance.js';
import { DemoInputRepository } from '../../src/persistence/repositories/demo-input.repo.js';
import { LeadFactsRepository } from '../../src/persistence/repositories/lead-facts.repo.js';
import { LeadsRepository } from '../../src/persistence/repositories/leads.repo.js';
import { PipelineRunsRepository } from '../../src/persistence/repositories/runs.repo.js';
import { auditFindings, auditRuns, emailDrafts, emailFactInputs, emailFindingInputs, modelCalls, opportunityAssessments } from '../../src/persistence/schema.js';

const DATABASE_URL = process.env.DATABASE_URL;
const logger = pino({ level: 'silent' });

describe.skipIf(!DATABASE_URL)('generateEmails (PostgreSQL)', () => {
  let handle: DbHandle;
  beforeEach(async () => { handle ??= createDb(DATABASE_URL as string); await truncateAll(handle.db); });
  afterAll(async () => { if (handle) await handle.pool.end(); });

  async function seed(): Promise<string> {
    const leads = new LeadsRepository(handle.db);
    const lead = buildCandidateLead({ sourcePlaceId: `p-${randomUUID()}`, source: 'mock' });
    await leads.create(lead);
    await handle.db.transaction(async (tx) => {
      const fr = new LeadFactsRepository(tx);
      for (const [t, v] of [['business_name', 'Zahnärzte am Ufer'], ['city', 'Berlin'], ['services', 'Implantology|Whitening']] as [string, string][])
        await fr.writeCurrentFact({ leadId: lead.id, factType: t as never, value: v, normalizedValue: v.toLowerCase(), sourceType: 'website', sourceUrl: null, confidence: 1 });
    });
    await leads.updateStatus(lead.id, 'OPPORTUNITY_READY', new Date());
    await leads.updateStatus(lead.id, 'DEMO_DECIDED', new Date());
    await leads.updateStatus(lead.id, 'DEMO_READY', new Date());
    const runId = randomUUID();
    await handle.db.insert(auditRuns).values({ id: runId, leadId: lead.id, outcome: 'AUDITED', rubricVersion: 'r', generatorPromptVersion: 'g', reviewerPromptVersion: 'rev', schemaVersion: 's', opportunityRulesVersion: 'opp', opportunityRulesHash: 'h', provider: 'mock', requestedAuditModel: 'm', reasoningEffort: 'medium', reasoningMode: 'standard', imageDetail: 'high', responseStore: false, inputFingerprint: 'fp', startedAt: new Date() });
    await handle.db.insert(auditFindings).values({ id: randomUUID(), auditRunId: runId, findingRef: 'F1', category: 'CTA_CLARITY', observation: 'CTA hard to find', affectedUrls: [], affectedProfiles: ['DESKTOP'], severity: 'MEDIUM', confidence: 0.8, businessImpact: 'i', recommendation: 'Make CTA prominent', safeForOutreach: true, reviewDecision: 'APPROVE' });
    await handle.db.insert(opportunityAssessments).values({ id: randomUUID(), auditRunId: runId, leadId: lead.id, conversionScore: 60, mobileScore: 0, trustScore: 0, contactabilityScore: 0, overallScore: 60, rulesVersion: 'opp', rulesHash: 'h', breakdown: [], capsApplied: [] });
    return lead.id;
  }

  function service(): EmailWriterService {
    return new EmailWriterService({
      provider: new MockLlmProvider(defaultMockEmailResponder), uow: new DrizzleEmailUnitOfWork(handle.db), logger,
      config: { writerModel: 'gpt-5.6-sol', reviewerModel: 'gpt-5.6-terra', writerEffort: 'medium', reviewerEffort: 'medium', store: false, timeoutMs: 1000, maxOutputTokens: 1500, maxRetries: 0, maxCallsPerLead: 2, maxCostUsdPerLead: 0.2, worstCaseInputTokensPerCall: worstCaseEmailInputTokens() },
    });
  }

  it('APPROVED_READY: persists draft + provenance + model_calls; lead → READY_FOR_HUMAN_APPROVAL', async () => {
    const leadId = await seed();
    const audit = await new DemoInputRepository(handle.db).latestAuditForComposer(leadId);
    const facts = await new LeadFactsRepository(handle.db).listCurrentFacts(leadId);
    const runId = await new PipelineRunsRepository(handle.db).start('emails:test', true);
    const r = await service().write({ leadId, facts, findings: audit?.findings ?? [], demo: null, opportunityScore: audit?.opportunityScore ?? null }, runId);
    expect(r.outcome).toBe('APPROVED_READY');

    expect((await new LeadsRepository(handle.db).getById(leadId))?.status).toBe('READY_FOR_HUMAN_APPROVAL');

    const rows = await handle.db.select().from(emailDrafts).where(eq(emailDrafts.leadId, leadId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('APPROVED');
    expect(rows[0]?.ctaKind).toBe('reply');
    expect(rows[0]?.body).toMatch(/^Hello,/);
    expect(rows[0]?.reviewerDecision).toBe('APPROVE');

    const emailId = rows[0]!.id;
    expect((await handle.db.select().from(emailFactInputs).where(eq(emailFactInputs.emailId, emailId))).length).toBeGreaterThan(0);
    expect((await handle.db.select().from(emailFindingInputs).where(eq(emailFindingInputs.emailId, emailId))).length).toBeGreaterThanOrEqual(1);
    const calls = await handle.db.select().from(modelCalls).where(eq(modelCalls.leadId, leadId));
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.auditRunId === null)).toBe(true);
  });
});
