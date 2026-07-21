import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requireIntegrationTestDatabase } from '../support/test-database.js';
import { DemoComposerService } from '../../src/domain/demo/composer/demo-composer-service.js';
import { COMPOSER_TEMPLATE_ID, COMPOSER_TEMPLATE_VERSION } from '../../src/domain/demo/composer/compose.js';
import { worstCaseComposerInputTokens } from '../../src/domain/demo/composer/composer-token-budget.js';
import { buildCandidateLead } from '../../src/domain/leads/lead-factory.js';
import { defaultMockComposerResponder } from '../../src/fixtures/mock-composer-responses.js';
import { LocalDemoWriter } from '../../src/integrations/demo/demo-writer.js';
import { MockLlmProvider } from '../../src/integrations/llm/mock-llm.js';
import { type DbHandle } from '../../src/persistence/db.js';
import { DrizzleComposerUnitOfWork } from '../../src/persistence/composer-unit-of-work.js';
import { DemoInputRepository } from '../../src/persistence/repositories/demo-input.repo.js';
import { LeadFactsRepository } from '../../src/persistence/repositories/lead-facts.repo.js';
import { LeadsRepository } from '../../src/persistence/repositories/leads.repo.js';
import { PipelineRunsRepository } from '../../src/persistence/repositories/runs.repo.js';
import {
  auditFindings, auditRuns, demoDesignSpecs, demoFactInputs, demoFindingInputs, demos, modelCalls, opportunityAssessments,
} from '../../src/persistence/schema.js';

const testDatabase = requireIntegrationTestDatabase();
const logger = pino({ level: 'silent' });

describe('composeDemos (PostgreSQL)', () => {
  let handle: DbHandle;
  let outDir: string;

  beforeEach(async () => {
    handle ??= testDatabase.createHandle();
    await testDatabase.truncate(handle.db);
    outDir = await mkdtemp(join(tmpdir(), 'compose-'));
  });
  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });
  afterAll(async () => {
    if (handle) await handle.pool.end();
  });

  async function seed(): Promise<string> {
    const leads = new LeadsRepository(handle.db);
    const lead = buildCandidateLead({ sourcePlaceId: `p-${randomUUID()}`, source: 'mock' });
    await leads.create(lead);
    await handle.db.transaction(async (tx) => {
      const fr = new LeadFactsRepository(tx);
      const facts: [string, string][] = [
        ['business_name', 'Zahnärzte am Ufer'], ['city', 'Berlin'], ['phone', '+49 30 1234567'],
        ['contact_email', 'info@zahnaerzte-am-ufer.de'], ['formatted_address', 'Uferstr. 1, Berlin'],
        ['services', 'Implantology|Whitening'], ['official_website_url', 'https://zahnaerzte-am-ufer.de/'],
      ];
      for (const [t, v] of facts) await fr.writeCurrentFact({ leadId: lead.id, factType: t as never, value: v, normalizedValue: v.toLowerCase(), sourceType: 'website', sourceUrl: null, confidence: 1 });
    });
    await leads.updateStatus(lead.id, 'OPPORTUNITY_READY', new Date());

    const runId = randomUUID();
    await handle.db.insert(auditRuns).values({
      id: runId, leadId: lead.id, outcome: 'AUDITED', rubricVersion: 'r', generatorPromptVersion: 'g', reviewerPromptVersion: 'rev',
      schemaVersion: 's', opportunityRulesVersion: 'opp', opportunityRulesHash: 'h', provider: 'mock', requestedAuditModel: 'm',
      reasoningEffort: 'medium', reasoningMode: 'standard', imageDetail: 'high', responseStore: false, inputFingerprint: 'fp', startedAt: new Date(),
    });
    await handle.db.insert(auditFindings).values({
      id: randomUUID(), auditRunId: runId, findingRef: 'F1', category: 'CTA_CLARITY', observation: 'CTA is hard to find', affectedUrls: [], affectedProfiles: ['DESKTOP'],
      severity: 'MEDIUM', confidence: 0.8, businessImpact: 'i', recommendation: 'Make the primary CTA prominent', safeForOutreach: true, reviewDecision: 'APPROVE',
    });
    await handle.db.insert(opportunityAssessments).values({
      id: randomUUID(), auditRunId: runId, leadId: lead.id, conversionScore: 60, mobileScore: 0, trustScore: 0, contactabilityScore: 0,
      overallScore: 60, rulesVersion: 'opp', rulesHash: 'h', breakdown: [], capsApplied: [],
    });
    return lead.id;
  }

  function service(): DemoComposerService {
    return new DemoComposerService({
      provider: new MockLlmProvider(defaultMockComposerResponder),
      uow: new DrizzleComposerUnitOfWork(handle.db),
      writer: new LocalDemoWriter(outDir),
      logger,
      config: {
        generatorModel: 'gpt-5.6-sol', reviewerModel: 'gpt-5.6-terra', generatorEffort: 'medium', reviewerEffort: 'medium',
        store: false, timeoutMs: 1000, maxOutputTokens: 2500, maxRetries: 0, maxCallsPerDemo: 2, maxCostUsdPerDemo: 0.35,
        worstCaseInputTokensPerCall: worstCaseComposerInputTokens(), templateId: COMPOSER_TEMPLATE_ID, templateVersion: COMPOSER_TEMPLATE_VERSION,
      },
    });
  }

  it('DEMO_COMPOSED: persists demo, design spec, provenance, model_calls; lead → DEMO_READY', async () => {
    const leadId = await seed();
    const input = await new DemoInputRepository(handle.db).latestAuditForComposer(leadId);
    const facts = await new LeadFactsRepository(handle.db).listCurrentFacts(leadId);
    const runId = await new PipelineRunsRepository(handle.db).start('compose:test', true);
    const r = await service().compose({ leadId, facts, opportunityScore: input?.opportunityScore ?? null, findings: input?.findings ?? [] }, runId);
    expect(r.outcome).toBe('DEMO_COMPOSED');
    expect(r.costUsd).toBe(0);

    expect((await new LeadsRepository(handle.db).getById(leadId))?.status).toBe('DEMO_READY');

    const demoRows = await handle.db.select().from(demos).where(eq(demos.leadId, leadId));
    expect(demoRows).toHaveLength(1);
    const demo = demoRows[0];
    expect(demo?.status).toBe('GENERATED_PENDING_REVIEW');
    expect(demo?.templateId).toBe(COMPOSER_TEMPLATE_ID);
    expect(demo?.approvedAt).toBeNull(); // generation is separate from approval

    const specRows = await handle.db.select().from(demoDesignSpecs).where(eq(demoDesignSpecs.demoId, demo?.id ?? ''));
    expect(specRows).toHaveLength(1);
    expect(specRows[0]?.reviewerDecision).toBe('APPROVE');
    expect(specRows[0]?.fabricationRisk).toBe(false);

    const factInputs = await handle.db.select().from(demoFactInputs).where(eq(demoFactInputs.demoId, demo?.id ?? ''));
    expect(factInputs.length).toBeGreaterThan(0);
    const findingInputs = await handle.db.select().from(demoFindingInputs).where(eq(demoFindingInputs.demoId, demo?.id ?? ''));
    expect(findingInputs.length).toBeGreaterThanOrEqual(1);

    const calls = await handle.db.select().from(modelCalls).where(eq(modelCalls.leadId, leadId));
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.auditRunId === null)).toBe(true);

    const html = await readFile(join(demo?.path ?? '', 'index.html'), 'utf8');
    expect(html).toMatch(/noindex,nofollow,noarchive/);
    expect(html).toMatch(/concept redesign/i);
    expect(html).toContain('Zahnärzte am Ufer');
  });
});
