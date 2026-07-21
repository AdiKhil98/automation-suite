import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { requireIntegrationTestDatabase } from '../support/test-database.js';
import {
  CaptureService,
  type CaptureTxRepos,
  type CaptureUnitOfWork,
} from '../../src/domain/capture/capture-service.js';
import { buildCandidateLead } from '../../src/domain/leads/lead-factory.js';
import { LeadService } from '../../src/domain/leads/lead-service.js';
import { MockCaptureProvider, type MockPageSpec } from '../../src/integrations/capture/mock-capture.js';
import { LocalFsCaptureStorage } from '../../src/integrations/capture/local-fs-storage.js';
import { type DbHandle } from '../../src/persistence/db.js';
import { DrizzleCaptureUnitOfWork } from '../../src/persistence/capture-unit-of-work.js';
import { CaptureRepository } from '../../src/persistence/repositories/capture.repo.js';
import { LeadFactsRepository } from '../../src/persistence/repositories/lead-facts.repo.js';
import { LeadsRepository } from '../../src/persistence/repositories/leads.repo.js';
import { PipelineRepository } from '../../src/persistence/repositories/pipeline.repo.js';
import { PipelineRunsRepository } from '../../src/persistence/repositories/runs.repo.js';
import {
  captureArtifacts,
  capturedPages,
  enrichmentAttempts,
  enrichmentCandidates,
  websiteCaptureRuns,
} from '../../src/persistence/schema.js';

const testDatabase = requireIntegrationTestDatabase();

const RENDERABLE = '<html lang="en"><head><title>Acme Dental</title></head><body><h1>Acme Dental</h1><p>Welcome to our Manchester dental practice — book an appointment today.</p><a href="tel:+441614960000">Call</a></body></html>';

const CONFIG = {
  maxPages: 5,
  navigationTimeoutMs: 5000,
  totalTimeoutMs: 20000,
  maxScreenshotBytes: 5_000_000,
  fullPageMaxHeightPx: 20000,
  blockTrackers: true,
  blockMedia: true,
  minConfidence: 0.6,
  ambiguousMargin: 0.1,
};

describe('captureWebsites (PostgreSQL)', () => {
  let handle: DbHandle;
  let artDir: string;

  beforeEach(async () => {
    handle ??= testDatabase.createHandle();
    await testDatabase.truncate(handle.db);
    artDir = await mkdtemp(join(tmpdir(), 'capdb-'));
  });
  afterAll(async () => {
    if (handle) await handle.pool.end();
  });

  async function seed(
    status: 'READY_FOR_CAPTURE',
    facts: Array<{ factType: string; value: string; source: 'mock' | 'manual' | 'website' }>,
  ): Promise<string> {
    const leads = new LeadsRepository(handle.db);
    const factsRepo = new LeadFactsRepository(handle.db);
    const lead = buildCandidateLead({ sourcePlaceId: `place-${randomUUID()}`, source: 'mock' });
    await leads.create(lead);
    for (const f of facts) {
      await factsRepo.writeCurrentFact({ leadId: lead.id, factType: f.factType as never, value: f.value, normalizedValue: f.value.toLowerCase(), sourceType: f.source, sourceUrl: null });
    }
    await leads.updateStatus(lead.id, status, new Date());
    return lead.id;
  }

  function service(pages: Map<string, MockPageSpec>, uow?: CaptureUnitOfWork): { svc: CaptureService; storage: LocalFsCaptureStorage } {
    const storage = new LocalFsCaptureStorage(artDir);
    const svc = new CaptureService({
      provider: new MockCaptureProvider(pages),
      storage,
      uow: uow ?? new DrizzleCaptureUnitOfWork(handle.db),
      logger: { error: () => undefined } as never,
      config: CONFIG,
    });
    return { svc, storage };
  }

  async function run(svc: CaptureService, input: Parameters<CaptureService['capture']>[0]): Promise<string> {
    const runId = await new PipelineRunsRepository(handle.db).start('capture:test', true);
    const r = await svc.capture(input, runId);
    return r.outcome;
  }

  it('AUDIT CAPTURED: writes run/pages/artifacts and routes to READY_FOR_AUDIT', async () => {
    const url = 'https://acme.example';
    const id = await seed('READY_FOR_CAPTURE', [{ factType: 'official_website_url', value: url, source: 'website' }]);
    const { svc, storage } = service(new Map([[url, { html: RENDERABLE }]]));
    expect(await run(svc, { leadId: id, purpose: 'AUDIT_CAPTURE', facts: await new LeadFactsRepository(handle.db).listCurrentFacts(id) })).toBe('CAPTURED');

    expect((await new LeadsRepository(handle.db).getById(id))?.status).toBe('READY_FOR_AUDIT');
    const runs = await handle.db.select().from(websiteCaptureRuns).where(eq(websiteCaptureRuns.leadId, id));
    expect(runs[0]?.outcome).toBe('CAPTURED');
    expect(runs[0]?.desktopPrimaryComplete && runs[0]?.mobilePrimaryComplete).toBe(true);
    const pages = await handle.db.select().from(capturedPages);
    expect(pages.length).toBeGreaterThanOrEqual(2); // desktop + mobile
    const arts = await handle.db.select().from(captureArtifacts);
    expect(arts.length).toBeGreaterThanOrEqual(2);
    expect(await storage.read(arts[0]!.sha256)).not.toBeNull(); // committed blob
  });

  it('routes INVALID_TARGET / BOT_CHALLENGE / TRANSIENT_ERROR correctly', async () => {
    const noTarget = await seed('READY_FOR_CAPTURE', [{ factType: 'business_name', value: 'X', source: 'mock' }]);
    expect(await run(service(new Map()).svc, { leadId: noTarget, purpose: 'AUDIT_CAPTURE', facts: await new LeadFactsRepository(handle.db).listCurrentFacts(noTarget) })).toBe('INVALID_TARGET');
    expect((await new LeadsRepository(handle.db).getById(noTarget))?.status).toBe('NEEDS_MANUAL_REVIEW');

    const botUrl = 'https://bot.example';
    const botLead = await seed('READY_FOR_CAPTURE', [{ factType: 'official_website_url', value: botUrl, source: 'website' }]);
    expect(await run(service(new Map([[botUrl, { html: '', primaryError: 'bot_challenge' }]])).svc, { leadId: botLead, purpose: 'AUDIT_CAPTURE', facts: await new LeadFactsRepository(handle.db).listCurrentFacts(botLead) })).toBe('BOT_CHALLENGE');
    expect((await new LeadsRepository(handle.db).getById(botLead))?.status).toBe('NEEDS_MANUAL_REVIEW');

    const downUrl = 'https://down.example';
    const downLead = await seed('READY_FOR_CAPTURE', [{ factType: 'official_website_url', value: downUrl, source: 'website' }]);
    expect(await run(service(new Map([[downUrl, { html: '', ok: false }]])).svc, { leadId: downLead, purpose: 'AUDIT_CAPTURE', facts: await new LeadFactsRepository(handle.db).listCurrentFacts(downLead) })).toBe('TRANSIENT_ERROR');
    expect((await new LeadsRepository(handle.db).getById(downLead))?.status).toBe('READY_FOR_CAPTURE');
  });

  it('rolls back the whole capture and cleans up temp artifacts on failure', async () => {
    const url = 'https://acme.example';
    const id = await seed('READY_FOR_CAPTURE', [{ factType: 'official_website_url', value: url, source: 'website' }]);
    const failing: CaptureUnitOfWork = {
      transaction: (fn) =>
        handle.db.transaction(async (tx) => {
          const leads = new LeadsRepository(tx);
          const repos: CaptureTxRepos = {
            leads,
            leadService: new LeadService(leads, new PipelineRepository(tx)),
            capture: new CaptureRepository(tx),
            facts: new LeadFactsRepository(tx),
            events: { record: async () => { throw new Error('injected'); } },
          };
          return fn(repos);
        }),
    };
    const { svc, storage } = service(new Map([[url, { html: RENDERABLE }]]), failing);
    await expect(run(svc, { leadId: id, purpose: 'AUDIT_CAPTURE', facts: await new LeadFactsRepository(handle.db).listCurrentFacts(id) })).rejects.toThrow(/injected/);

    expect(await handle.db.select().from(websiteCaptureRuns)).toHaveLength(0);
    expect((await new LeadsRepository(handle.db).getById(id))?.status).toBe('READY_FOR_CAPTURE');
    expect(await storage.gc(new Set())).toBe(0); // temp discarded → nothing committed
  });

  it('VERIFICATION: verifies a BROWSER_REQUIRED candidate and writes official facts', async () => {
    const url = 'https://verify.example';
    const id = await seed('READY_FOR_CAPTURE', [
      { factType: 'business_name', value: 'Acme Dental', source: 'mock' },
      { factType: 'phone', value: '0161 496 0000', source: 'mock' },
    ]);
    // Stored Phase-4 BROWSER_REQUIRED enrichment attempt + candidate.
    const runId = await new PipelineRunsRepository(handle.db).start('enrich:seed', true);
    const attemptId = randomUUID();
    await handle.db.insert(enrichmentAttempts).values({ id: attemptId, leadId: id, runId, outcome: 'BROWSER_REQUIRED', candidateCount: 1, startedAt: new Date() });
    const candidateId = randomUUID();
    await handle.db.insert(enrichmentCandidates).values({ id: candidateId, attemptId, discoveredUrl: url, decision: 'AMBIGUOUS' });

    const page: MockPageSpec = { html: RENDERABLE };
    const { svc } = service(new Map([[url, page]]));
    const target = await new CaptureRepository(handle.db).getVerificationTarget(id);
    expect(target?.url).toBe(url);
    await svc.capture({ leadId: id, purpose: 'VERIFICATION_CAPTURE', facts: await new LeadFactsRepository(handle.db).listCurrentFacts(id), verificationTargetUrl: target!.url, sourceEnrichmentCandidateId: target!.candidateId }, runId);

    const official = await new LeadFactsRepository(handle.db).getCurrentFact(id, 'official_domain');
    expect(official?.value).toBe('verify.example');
    expect((await new LeadsRepository(handle.db).getById(id))?.status).toBe('READY_FOR_CAPTURE'); // ready for a real audit capture
    const runs = await handle.db.select().from(websiteCaptureRuns).where(eq(websiteCaptureRuns.leadId, id));
    expect(runs[0]?.purpose).toBe('VERIFICATION_CAPTURE');
    expect(runs[0]?.sourceEnrichmentCandidateId).toBe(candidateId);
  });
});
