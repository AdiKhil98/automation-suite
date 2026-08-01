import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { requireIntegrationTestDatabase } from '../support/test-database.js';
import {
  CompetitorCaptureService,
  type CaptureRunInput,
  type CompetitorCaptureConfig,
} from '../../src/domain/competitor/capture-service.js';
import { DrizzleCompetitorCaptureUnitOfWork } from '../../src/persistence/competitor-capture-unit-of-work.js';
import { CompetitorCaptureRepository } from '../../src/persistence/repositories/competitor-capture.repo.js';
import { MockCaptureProvider, type MockPageSpec } from '../../src/integrations/capture/mock-capture.js';
import { type DbHandle } from '../../src/persistence/db.js';
import { competitorCandidates, competitorResearchRuns, leads } from '../../src/persistence/schema.js';

const testDatabase = requireIntegrationTestDatabase();

const HOME = `<html lang="de"><body>
  <nav><a href="https://competitor-a.de/kontakt">Kontakt</a></nav>
  <h1>Praxis</h1>
  <a class="btn" href="https://competitor-a.de/termin">Termin buchen</a>
  <a href="tel:+49301234567">Anrufen</a>
  <address>Hauptstr 1, Berlin</address>
</body></html>`;

const CONFIG: CompetitorCaptureConfig = {
  maxPages: 2, maxDepth: 1, navigationTimeoutMs: 15_000, totalTimeoutMs: 60_000,
  maxScreenshotBytes: 5_000_000, fullPageMaxHeightPx: 20_000, blockTrackers: true, blockMedia: true, maxAgeDays: 30,
};

function provider(): MockCaptureProvider {
  return new MockCaptureProvider(new Map<string, MockPageSpec>([['https://competitor-a.de', { html: HOME }]]));
}

describe('competitor capture persistence (PostgreSQL)', () => {
  let handle: DbHandle;

  beforeEach(async () => {
    handle ??= testDatabase.createHandle();
    await testDatabase.truncate(handle.db);
  });

  afterAll(async () => {
    if (handle) await handle.pool.end();
  });

  async function seed(): Promise<{ leadId: string; researchRunId: string; candidateId: string }> {
    const leadId = randomUUID();
    const researchRunId = randomUUID();
    const candidateId = randomUUID();
    await handle.db.insert(leads).values({ id: leadId, normalizedDomain: 'prospect.example', status: 'OPPORTUNITY_READY' });
    await handle.db.insert(competitorResearchRuns).values({
      id: researchRunId, leadId, runId: null, provider: 'fixture', status: 'DRAFT', outcome: 'RESEARCHED',
      activeRadius: 'PRIMARY_5KM', inputHash: 'ih', configHash: 'ch', rulesVersion: 'comp-cmp-1', version: 1,
      candidateCount: 1, acceptedCount: 1, rejectedCount: 0, primaryRadiusKm: 5, fallbackRadiusKm: 10, maxSelected: 3,
    });
    await handle.db.insert(competitorCandidates).values({
      id: candidateId, researchRunId, rowIndex: 1, normalizedDomain: 'competitor-a.de', brandKey: 'competitor-a.de',
      secondaryCategories: [], normalizedServices: [], disposition: 'ACCEPTED', reasonDetail: 'accepted',
      scoreBreakdown: [], gateResults: [],
    });
    return { leadId, researchRunId, candidateId };
  }

  function input(over: Partial<CaptureRunInput>, leadId: string, researchRunId: string, candidateId: string): CaptureRunInput {
    return {
      leadId, researchRunId, prospectNormalizedDomain: 'prospect.example',
      competitors: [{ competitorCandidateId: candidateId, disposition: 'ACCEPTED', normalizedDomain: 'competitor-a.de' }],
      method: 'FIXTURE', provider: 'fixture', liveEnabled: false, liveConfirmed: false, apply: true, ...over,
    };
  }

  it('persists a DRAFT capture run + pages + evidence, retains no raw HTML, and is idempotent', async () => {
    const { leadId, researchRunId, candidateId } = await seed();
    const svc = new CompetitorCaptureService({ provider: provider(), uow: new DrizzleCompetitorCaptureUnitOfWork(handle.db), config: CONFIG });
    const repo = new CompetitorCaptureRepository(handle.db);

    const first = await svc.run(input({}, leadId, researchRunId, candidateId));
    expect(first.persisted).toBe(true);
    expect(first.version).toBe(1);

    const runs = await repo.listRunsForLead(leadId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('DRAFT');

    const pages = await repo.getPages(runs[0]?.id ?? '');
    expect(pages.length).toBeGreaterThan(0);
    // No raw HTML column exists; ok pages retain only a content hash.
    for (const p of pages.filter((x) => x.ok)) expect(typeof p.rawDomHash).toBe('string');
    expect(Object.keys(pages[0] ?? {})).not.toContain('html');

    const evidence = await repo.getEvidence(runs[0]?.id ?? '');
    expect(evidence.some((e) => e.evidenceCategory === 'PHONE_VISIBLE' && e.active)).toBe(true);

    const svc2 = new CompetitorCaptureService({ provider: provider(), uow: new DrizzleCompetitorCaptureUnitOfWork(handle.db), config: CONFIG });
    const second = await svc2.run(input({}, leadId, researchRunId, candidateId));
    expect(second.reusedExisting).toBe(true);
    expect(await repo.listRunsForLead(leadId)).toHaveLength(1);
  });

  it('invalidates one active evidence item while preserving it as inactive history', async () => {
    const { leadId, researchRunId, candidateId } = await seed();
    const svc = new CompetitorCaptureService({ provider: provider(), uow: new DrizzleCompetitorCaptureUnitOfWork(handle.db), config: CONFIG });
    const repo = new CompetitorCaptureRepository(handle.db);
    const res = await svc.run(input({}, leadId, researchRunId, candidateId));
    const runId = res.runRecordId ?? '';
    const active = (await repo.getEvidence(runId)).find((e) => e.active);
    expect(active).toBeTruthy();

    const changed = await repo.invalidateEvidence(active?.id ?? '');
    expect(changed).toBe(true);

    const after = (await repo.getEvidence(runId)).find((e) => e.id === active?.id);
    expect(after?.active).toBe(false);
    expect(after?.safeForOutreach).toBe(false);
    expect(after?.freshnessStatus).toBe('UNREPRODUCIBLE');
    // Idempotent: a second invalidation is a no-op.
    expect(await repo.invalidateEvidence(active?.id ?? '')).toBe(false);
  });
});
