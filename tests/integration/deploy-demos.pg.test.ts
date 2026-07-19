import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashCanonical } from '../../src/utils/hash.js';
import { DeploymentService, type DeployConfig, type VerifyFetchFn } from '../../src/domain/deploy/deployment-service.js';
import { ReviewService } from '../../src/domain/review/review-service.js';
import { MockNetlifyDeploymentProvider } from '../../src/integrations/netlify/mock-netlify.js';
import { buildCandidateLead } from '../../src/domain/leads/lead-factory.js';
import { createDb, type DbHandle } from '../../src/persistence/db.js';
import { DrizzleDeployUnitOfWork } from '../../src/persistence/deploy-unit-of-work.js';
import { DrizzleReviewUnitOfWork } from '../../src/persistence/review-unit-of-work.js';
import { DeployRepository } from '../../src/persistence/repositories/deploy.repo.js';
import { DeployInputRepository } from '../../src/persistence/repositories/deploy-input.repo.js';
import { ReviewReadRepository } from '../../src/persistence/repositories/review.repo.js';
import { LeadFactsRepository } from '../../src/persistence/repositories/lead-facts.repo.js';
import { LeadsRepository } from '../../src/persistence/repositories/leads.repo.js';
import { PipelineRunsRepository } from '../../src/persistence/repositories/runs.repo.js';
import { truncateAll } from '../../src/persistence/maintenance.js';
import { demoDecisions, demoDeploymentRuns, demos, emailDraftFinalizations, emailDrafts, leads as leadsTbl } from '../../src/persistence/schema.js';

const DATABASE_URL = process.env.DATABASE_URL;
const logger = pino({ level: 'silent' });
const HOST = 'deploy-preview.netlify.app';
const DEMO_HTML = `<!doctype html><html lang="en"><head><meta name="robots" content="noindex,nofollow,noarchive"><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><title>x — concept redesign (demo)</title></head><body><a class="cta" href="#contact">Get in touch</a><div>concept redesign</div></body></html>`;
const ARTIFACT_HASH = hashCanonical({ html: DEMO_HTML, template: 'composer-v1', version: 'composer-tpl-1' });
const okFetch: VerifyFetchFn = (url) => Promise.resolve({ kind: 'ok', status: 200, finalUrl: url, host: new URL(url).host, headers: { 'x-robots-tag': 'noindex' }, body: DEMO_HTML });

describe.skipIf(!DATABASE_URL)('deployDemos (PostgreSQL)', () => {
  let handle: DbHandle;
  let dir: string;
  beforeEach(async () => { handle ??= createDb(DATABASE_URL as string); await truncateAll(handle.db); dir = await mkdtemp(join(tmpdir(), 'deploy-pg-')); await writeFile(join(dir, 'index.html'), DEMO_HTML, 'utf8'); await writeFile(join(dir, 'netlify.toml'), '# x', 'utf8'); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
  afterAll(async () => { if (handle) await handle.pool.end(); });

  async function seed(): Promise<string> {
    const leads = new LeadsRepository(handle.db);
    const lead = buildCandidateLead({ sourcePlaceId: `p-${randomUUID()}`, source: 'mock' });
    await leads.create(lead);
    await handle.db.transaction(async (tx) => { await new LeadFactsRepository(tx).writeCurrentFact({ leadId: lead.id, factType: 'business_name', value: 'Z', normalizedValue: 'z', sourceType: 'website', sourceUrl: null, confidence: 1 }); });
    for (const s of ['OPPORTUNITY_READY', 'DEMO_DECIDED', 'DEMO_READY', 'EMAIL_DRAFTED', 'EMAIL_APPROVED', 'WAITING_FOR_DEMO_URL'])
      await leads.updateStatus(lead.id, s as never, new Date());
    const decId = randomUUID();
    await handle.db.insert(demoDecisions).values({ id: decId, leadId: lead.id, decision: 'BUILD_DEMO', outcome: 'DEMO_COMPOSED', reason: 'seed', opportunityScore: 60, minOpportunity: 0, justifiedByScore: true, justifiedByFinding: true, briefRulesVersion: 'x' });
    await handle.db.insert(demos).values({ id: randomUUID(), leadId: lead.id, demoDecisionId: decId, templateId: 'composer-v1', templateVersion: 'composer-tpl-1', path: dir, status: 'APPROVED', noindexVerified: true, disclosurePresent: true, contentHash: ARTIFACT_HASH, ctaKind: 'scroll', factsUsed: [], findingRefs: [], approvedAt: new Date(), approvedBy: 'local-reviewer', approvalSource: 'dashboard' });
    await handle.db.insert(emailDrafts).values({ id: randomUUID(), leadId: lead.id, runId: null, subject: 'Hi', body: 'Hallo, {{DEMO_URL}} Text', ctaKind: 'demo_link', hasDemoUrlPlaceholder: true, status: 'APPROVED', writerPromptVersion: 'w', reviewerPromptVersion: 'r', schemaVersion: 's', rulesVersion: 'v', provider: 'mock', requestedWriterModel: 'm', requestedReviewerModel: 'm', reviewerDecision: 'APPROVE', humanDecision: 'APPROVED', humanReviewedAt: new Date(), humanReviewedBy: 'local-reviewer', totalCostUsd: 0 });
    return lead.id;
  }

  const config: DeployConfig = { siteId: 's', expectedHostname: HOST, maxPerDay: 10, minIntervalMs: 0, maxUploadBytes: 1_000_000, maxUploadFiles: 10, pollIntervalMs: 0, maxPollAttempts: 3, verifyTimeoutMs: 500, featureEnabled: true, credentialsConfigured: true };
  const service = (provider = new MockNetlifyDeploymentProvider({ hostname: HOST })) => new DeploymentService({ provider, fetch: okFetch, store: new DeployRepository(handle.db), uow: new DrizzleDeployUnitOfWork(handle.db), logger, config, sleep: async () => {} });

  async function deployInput(leadId: string) {
    const data = await new DeployInputRepository(handle.db).latest(leadId);
    return { leadId, leadStatus: 'WAITING_FOR_DEMO_URL', demoDir: dir, demo: data.demo!, email: data.email };
  }

  it('deploys+verifies, persists run + finalization, lead → FINALIZED_EMAIL_PENDING; second approval → HUMAN_APPROVED', async () => {
    const leadId = await seed();
    const runId = await new PipelineRunsRepository(handle.db).start('deploy:test', true);
    const r = await service().deploy(await deployInput(leadId), runId);
    expect(r.outcome).toBe('DEPLOYED_AND_VERIFIED');

    const run = (await handle.db.select().from(demoDeploymentRuns).where(eq(demoDeploymentRuns.leadId, leadId)))[0];
    expect(run?.outcome).toBe('DEPLOYED_AND_VERIFIED');
    expect(run?.verifiedUrl).toContain(HOST);
    const fin = (await handle.db.select().from(emailDraftFinalizations))[0];
    expect(fin?.resolvedBody).not.toContain('{{DEMO_URL}}');
    expect((await handle.db.select().from(leadsTbl).where(eq(leadsTbl.id, leadId)))[0]?.status).toBe('FINALIZED_EMAIL_PENDING');

    // Second human approval of the finalized email.
    const review = new ReviewService({ uow: new DrizzleReviewUnitOfWork(handle.db), read: new ReviewReadRepository(handle.db), logger });
    expect(await review.decideFinalizedEmail(leadId, 'APPROVED', 'ship')).toBe('DONE');
    expect((await handle.db.select().from(leadsTbl).where(eq(leadsTbl.id, leadId)))[0]?.status).toBe('HUMAN_APPROVED');
    expect((await handle.db.select().from(emailDraftFinalizations))[0]?.finalHumanDecision).toBe('APPROVED');
  });

  it('re-running after a verified deploy reuses it (DUPLICATE_REUSED), no duplicate verified run', async () => {
    const leadId = await seed();
    const runs = new PipelineRunsRepository(handle.db);
    expect((await service().deploy(await deployInput(leadId), await runs.start('deploy:1', true))).outcome).toBe('DEPLOYED_AND_VERIFIED');
    // Reset lead to WAITING to attempt again; the verified artifact should be reused.
    await new LeadsRepository(handle.db).updateStatus(leadId, 'WAITING_FOR_DEMO_URL', new Date());
    const provider = new MockNetlifyDeploymentProvider({ hostname: HOST });
    const r2 = await service(provider).deploy(await deployInput(leadId), await runs.start('deploy:2', true));
    expect(r2.outcome).toBe('DUPLICATE_REUSED');
    expect(provider.created).toHaveLength(0);
    const verified = (await handle.db.select().from(demoDeploymentRuns).where(eq(demoDeploymentRuns.outcome, 'DEPLOYED_AND_VERIFIED')));
    expect(verified).toHaveLength(1);
  });
});
