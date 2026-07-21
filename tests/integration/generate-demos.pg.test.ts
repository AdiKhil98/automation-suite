import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requireIntegrationTestDatabase } from '../support/test-database.js';
import { DemoService } from '../../src/domain/demo/demo-service.js';
import { DEMO_TEMPLATE_ID, DEMO_TEMPLATE_VERSION } from '../../src/domain/demo/demo-types.js';
import { buildCandidateLead } from '../../src/domain/leads/lead-factory.js';
import { LocalDemoWriter } from '../../src/integrations/demo/demo-writer.js';
import { type DbHandle } from '../../src/persistence/db.js';
import { DrizzleDemoUnitOfWork } from '../../src/persistence/demo-unit-of-work.js';
import { DemoInputRepository } from '../../src/persistence/repositories/demo-input.repo.js';
import { LeadFactsRepository } from '../../src/persistence/repositories/lead-facts.repo.js';
import { LeadsRepository } from '../../src/persistence/repositories/leads.repo.js';
import { PipelineRunsRepository } from '../../src/persistence/repositories/runs.repo.js';
import { auditFindings, auditRuns, demoFactInputs, demoFindingInputs, demos, opportunityAssessments } from '../../src/persistence/schema.js';

const testDatabase = requireIntegrationTestDatabase();
const logger = pino({ level: 'silent' });

describe('generateDemos (PostgreSQL)', () => {
  let handle: DbHandle;
  let outDir: string;

  beforeEach(async () => {
    handle ??= testDatabase.createHandle();
    await testDatabase.truncate(handle.db);
    outDir = await mkdtemp(join(tmpdir(), 'demos-'));
  });
  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });
  afterAll(async () => {
    if (handle) await handle.pool.end();
  });

  /** Seed an OPPORTUNITY_READY lead with facts + an AUDITED run (findings + score). */
  async function seed(opts: { score: number; withFacts?: boolean; safeFinding?: boolean }): Promise<string> {
    const leads = new LeadsRepository(handle.db);
    const lead = buildCandidateLead({ sourcePlaceId: `p-${randomUUID()}`, source: 'mock' });
    await leads.create(lead);
    await handle.db.transaction(async (tx) => {
      const fr = new LeadFactsRepository(tx);
      const facts = opts.withFacts === false
        ? [['business_name', 'Solo Clinic']]
        : [['business_name', 'Zahnärzte am Ufer'], ['city', 'Berlin'], ['phone', '+49 30 1234567'], ['official_website_url', 'https://zahnaerzte-am-ufer.de/']];
      for (const [t, v] of facts) await fr.writeCurrentFact({ leadId: lead.id, factType: t as never, value: v, normalizedValue: v.toLowerCase(), sourceType: 'manual', sourceUrl: null, confidence: 1 });
    });
    await leads.updateStatus(lead.id, 'OPPORTUNITY_READY', new Date());

    const runId = randomUUID();
    await handle.db.insert(auditRuns).values({
      id: runId, leadId: lead.id, outcome: 'AUDITED', rubricVersion: 'r', generatorPromptVersion: 'g', reviewerPromptVersion: 'rev',
      schemaVersion: 's', opportunityRulesVersion: 'opp', opportunityRulesHash: 'h', provider: 'mock', requestedAuditModel: 'm',
      reasoningEffort: 'medium', reasoningMode: 'standard', imageDetail: 'high', responseStore: false, inputFingerprint: 'fp', startedAt: new Date(),
    });
    if (opts.safeFinding !== false) {
      await handle.db.insert(auditFindings).values({
        id: randomUUID(), auditRunId: runId, findingRef: 'F1', category: 'CTA_CLARITY', observation: 'o', affectedUrls: [], affectedProfiles: ['DESKTOP'],
        severity: 'MEDIUM', confidence: 0.8, businessImpact: 'i', recommendation: 'r', safeForOutreach: true, reviewDecision: 'APPROVE',
      });
    }
    await handle.db.insert(opportunityAssessments).values({
      id: randomUUID(), auditRunId: runId, leadId: lead.id, conversionScore: opts.score, mobileScore: 0, trustScore: 0, contactabilityScore: 0,
      overallScore: opts.score, rulesVersion: 'opp', rulesHash: 'h', breakdown: [], capsApplied: [],
    });
    return lead.id;
  }

  function service(): DemoService {
    return new DemoService({
      uow: new DrizzleDemoUnitOfWork(handle.db),
      writer: new LocalDemoWriter(outDir),
      logger,
      config: { minOpportunityForDemo: 35, templateId: DEMO_TEMPLATE_ID, templateVersion: DEMO_TEMPLATE_VERSION },
    });
  }

  async function run(leadId: string): Promise<string> {
    const input = await new DemoInputRepository(handle.db).latestAudit(leadId);
    const facts = await new LeadFactsRepository(handle.db).listCurrentFacts(leadId);
    const runId = await new PipelineRunsRepository(handle.db).start('demos:test', true);
    const r = await service().generate({ leadId, facts, opportunityScore: input?.opportunityScore ?? null, findings: input?.findings ?? [] }, runId);
    return r.outcome;
  }

  it('DEMO_BUILT: writes files, persists demo + relational provenance, lead → DEMO_READY', async () => {
    const leadId = await seed({ score: 10 }); // low score, but a demonstrable finding (Gate A shape)
    expect(await run(leadId)).toBe('DEMO_BUILT');

    expect((await new LeadsRepository(handle.db).getById(leadId))?.status).toBe('DEMO_READY');

    const demoRows = await handle.db.select().from(demos).where(eq(demos.leadId, leadId));
    expect(demoRows).toHaveLength(1);
    const demo = demoRows[0];
    expect(demo?.status).toBe('GENERATED_PENDING_REVIEW');
    expect(demo?.noindexVerified).toBe(true);
    expect(demo?.disclosurePresent).toBe(true);
    expect(demo?.approvedAt).toBeNull(); // generation is separate from approval

    // Relational provenance (amendment 4): FK links, not JSON-only.
    const factInputs = await handle.db.select().from(demoFactInputs).where(eq(demoFactInputs.demoId, demo?.id ?? ''));
    expect(factInputs.length).toBeGreaterThan(0);
    const findingInputs = await handle.db.select().from(demoFindingInputs).where(eq(demoFindingInputs.demoId, demo?.id ?? ''));
    expect(findingInputs.length).toBeGreaterThanOrEqual(1); // F1 → PROMINENT_CTA

    // The file exists and carries the safety directives.
    const html = await readFile(join(demo?.path ?? '', 'index.html'), 'utf8');
    expect(html).toMatch(/noindex,nofollow,noarchive/);
    expect(html).toMatch(/concept redesign/i);
  });

  it('NO_DEMO_INSUFFICIENT_FACTS: only a name → lead stays DEMO_DECIDED, no demo row', async () => {
    const leadId = await seed({ score: 90, withFacts: false, safeFinding: true });
    expect(await run(leadId)).toBe('NO_DEMO_INSUFFICIENT_FACTS');
    expect((await new LeadsRepository(handle.db).getById(leadId))?.status).toBe('DEMO_DECIDED');
    expect(await handle.db.select().from(demos).where(eq(demos.leadId, leadId))).toHaveLength(0);
  });

  it('NO_DEMO_NOT_JUSTIFIED: low score, no safe finding → DEMO_DECIDED', async () => {
    const leadId = await seed({ score: 5, safeFinding: false });
    expect(await run(leadId)).toBe('NO_DEMO_NOT_JUSTIFIED');
    expect((await new LeadsRepository(handle.db).getById(leadId))?.status).toBe('DEMO_DECIDED');
  });
});
