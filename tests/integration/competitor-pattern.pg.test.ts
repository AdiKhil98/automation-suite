import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { requireIntegrationTestDatabase } from '../support/test-database.js';
import { CompetitorPatternService } from '../../src/domain/competitor/pattern-service.js';
import { DrizzleCompetitorPatternUnitOfWork } from '../../src/persistence/competitor-pattern-unit-of-work.js';
import { CompetitorPatternRepository } from '../../src/persistence/repositories/competitor-pattern.repo.js';
import { type PatternBuildInput, type PatternCompetitorInput } from '../../src/domain/competitor/pattern-types.js';
import { recheckSupportingEvidence } from '../../src/cli/commands/competitor-pattern-build.js';
import { type CliContext } from '../../src/cli/context.js';
import { type DbHandle } from '../../src/persistence/db.js';
import {
  competitorCandidates,
  competitorCaptureRuns,
  competitorEvidenceItems,
  competitorResearchRuns,
  leads,
} from '../../src/persistence/schema.js';

const testDatabase = requireIntegrationTestDatabase();
const NOW = new Date('2026-02-01T00:00:00.000Z');

describe('competitor pattern package persistence (PostgreSQL)', () => {
  let handle: DbHandle;

  beforeEach(async () => {
    handle ??= testDatabase.createHandle();
    await testDatabase.truncate(handle.db);
  });

  afterAll(async () => {
    if (handle) await handle.pool.end();
  });

  async function seed(): Promise<{ leadId: string; researchRunId: string; captureRunId: string; competitors: PatternCompetitorInput[] }> {
    const leadId = randomUUID();
    const researchRunId = randomUUID();
    const captureRunId = randomUUID();
    await handle.db.insert(leads).values({ id: leadId, normalizedDomain: 'prospect.example', status: 'OPPORTUNITY_READY' });
    await handle.db.insert(competitorResearchRuns).values({
      id: researchRunId, leadId, runId: null, provider: 'fixture', status: 'DRAFT', outcome: 'RESEARCHED',
      activeRadius: 'PRIMARY_5KM', inputHash: 'ih', configHash: 'ch', rulesVersion: 'r1', version: 1,
      candidateCount: 2, acceptedCount: 2, rejectedCount: 0, primaryRadiusKm: 5, fallbackRadiusKm: 10, maxSelected: 3,
    });
    const candA = randomUUID();
    const candB = randomUUID();
    for (const [id, brand] of [[candA, 'brand-a'], [candB, 'brand-b']] as const) {
      await handle.db.insert(competitorCandidates).values({
        id, researchRunId, rowIndex: 1, normalizedDomain: `${brand}.de`, brandKey: brand, businessName: `Clinic ${brand}`,
        secondaryCategories: [], normalizedServices: [], disposition: 'ACCEPTED', reasonDetail: 'accepted', scoreBreakdown: [], gateResults: [],
      });
    }
    await handle.db.insert(competitorCaptureRuns).values({
      id: captureRunId, leadId, researchRunId, provider: 'fixture', method: 'FIXTURE', status: 'DRAFT', outcome: 'CAPTURED',
      rulesVersion: 'c1', version: 1, inputHash: 'cih', configHash: 'cch', contentHash: 'coh',
      competitorCount: 2, pageCount: 2, evidenceCount: 2, activeEvidenceCount: 2, withheldEvidenceCount: 0,
      maxPages: 2, maxDepth: 1, startedAt: NOW, completedAt: NOW,
    });
    const competitors: PatternCompetitorInput[] = [];
    for (const [id, brand] of [[candA, 'brand-a'], [candB, 'brand-b']] as const) {
      const evId = randomUUID();
      await handle.db.insert(competitorEvidenceItems).values({
        id: evId, captureRunId, competitorCandidateId: id, evidenceCategory: 'BOOKING_CTA_VISIBLE', observationKind: 'DIRECT_OBSERVATION',
        observation: 'Booking CTA visible', sourcePageUrl: `https://${brand}.de/`, normalizedOrigin: `${brand}.de`, selector: 'a.btn',
        sourceExcerpt: 'book now', profile: 'mobile', numericValue: null, confidence: 'HIGH', freshnessStatus: 'FRESH',
        withholdingReason: null, safeForOutreach: true, active: true, captureMethod: 'FIXTURE', provider: 'fixture',
        rulesVersion: 'c1', capturedAt: NOW, evidenceHash: `h-${evId}`,
      });
      competitors.push({
        competitorCandidateId: id, brandKey: brand, businessName: `Clinic ${brand}`, parentBrand: null,
        selected: true, captureActive: true, capturedOk: true,
        evidence: [{
          id: evId, captureRunId, competitorCandidateId: id, evidenceCategory: 'BOOKING_CTA_VISIBLE', observationKind: 'DIRECT_OBSERVATION',
          confidence: 'HIGH', storedFreshness: 'FRESH', safeForOutreach: true, active: true, sourcePageUrl: `https://${brand}.de/`, numericValue: null, capturedAt: NOW,
          polarity: 'PRESENT', inspectionScope: null,
        }],
      });
    }
    return { leadId, researchRunId, captureRunId, competitors };
  }

  function input(seeded: Awaited<ReturnType<typeof seed>>): PatternBuildInput {
    return {
      leadId: seeded.leadId, researchRunId: seeded.researchRunId, captureRunIds: [seeded.captureRunId],
      competitors: seeded.competitors,
      prospect: { leadId: seeded.leadId, captureRunId: null, capturedAt: null, capturedOk: false, refs: [], negatives: [] },
      now: NOW, maxAgeDays: 30,
    };
  }

  it('persists a DRAFT package + patterns + refs, is idempotent, and supports the approval workflow', async () => {
    const seeded = await seed();
    const svc = new CompetitorPatternService({ uow: new DrizzleCompetitorPatternUnitOfWork(handle.db) });
    const repo = new CompetitorPatternRepository(handle.db);

    const first = await svc.run(input(seeded), true);
    expect(first.persisted).toBe(true);
    expect(first.version).toBe(1);

    const packages = await repo.listPackagesForLead(seeded.leadId);
    expect(packages).toHaveLength(1);
    expect(packages[0]?.status).toBe('DRAFT');
    const pkgId = packages[0]?.id ?? '';

    const patterns = await repo.getPatterns(pkgId);
    const booking = patterns.find((p) => p.category === 'BOOKING_CTA_VISIBLE');
    expect(booking?.result).toBe('ALL_OBSERVED');
    expect(booking?.presentCount).toBe(2);
    expect((await repo.getEvidenceRefs(pkgId)).length).toBeGreaterThan(0);

    // Idempotent: identical inputs reuse the same version.
    const second = await svc.run(input(seeded), true);
    expect(second.reusedExisting).toBe(true);
    expect(await repo.listPackagesForLead(seeded.leadId)).toHaveLength(1);

    // Approval requires operator identity and preserves history.
    expect(await repo.approvePackage(pkgId, 'operator@example', NOW)).toBe(true);
    const approved = await repo.getPackage(pkgId);
    expect(approved?.status).toBe('APPROVED');
    expect(approved?.approvedBy).toBe('operator@example');
    // A second approval is a no-op (already terminal for that transition).
    expect(await repo.approvePackage(pkgId, 'operator@example', NOW)).toBe(false);

    // Invalidation preserves the row + references.
    expect(await repo.invalidatePackage(pkgId, 'operator@example', NOW)).toBe(true);
    expect((await repo.getPackage(pkgId))?.status).toBe('INVALIDATED');
    expect((await repo.getEvidenceRefs(pkgId)).length).toBeGreaterThan(0);
  });

  it('approval-time re-check BLOCKS when supporting evidence goes stale/invalidated/superseded after generation', async () => {
    const seeded = await seed();
    const svc = new CompetitorPatternService({ uow: new DrizzleCompetitorPatternUnitOfWork(handle.db) });
    const repo = new CompetitorPatternRepository(handle.db);
    const res = await svc.run(input(seeded), true);
    const pkg = await reconstructBuildFor(repo, res.packageRecordId ?? '');
    const ctx = { db: handle.db, config: { COMPETITOR_EVIDENCE_MAX_AGE_DAYS: 30 } } as unknown as CliContext;

    // Fresh at generation → clean re-check at NOW.
    expect(await recheckSupportingEvidence(ctx, pkg, NOW)).toHaveLength(0);

    // Evaluated far in the future → all supporting evidence is now stale → blocked.
    const future = new Date('2026-06-01T00:00:00.000Z');
    expect((await recheckSupportingEvidence(ctx, pkg, future)).length).toBeGreaterThan(0);

    // Invalidate one supporting item → blocked at NOW.
    const firstRef = pkg.evidenceRefs.find((r) => r.kind === 'COMPETITOR');
    await handle.db.update(competitorEvidenceItems).set({ active: false }).where(eq(competitorEvidenceItems.id, firstRef?.evidenceItemId ?? ''));
    expect((await recheckSupportingEvidence(ctx, pkg, NOW)).some((f) => f.includes('invalidated'))).toBe(true);

    // Supersede the capture run → blocked at NOW.
    await handle.db.update(competitorCaptureRuns).set({ status: 'SUPERSEDED' }).where(eq(competitorCaptureRuns.id, seeded.captureRunId));
    expect((await recheckSupportingEvidence(ctx, pkg, NOW)).some((f) => f.includes('superseded'))).toBe(true);
  });
});

/** Small helper: read a persisted package back into the domain contract for the freshness re-check. */
async function reconstructBuildFor(repo: CompetitorPatternRepository, packageId: string) {
  const row = await repo.getPackage(packageId);
  if (!row) throw new Error('package not found');
  const refs = await repo.getEvidenceRefs(packageId);
  return {
    leadId: row.leadId,
    contrasts: [],
    evidenceRefs: refs.map((r) => ({
      kind: r.kind as 'COMPETITOR' | 'PROSPECT',
      evidenceItemId: r.evidenceItemId,
      captureRunId: r.captureRunId,
      competitorCandidateId: r.competitorCandidateId,
      category: null,
      sourceUrl: r.sourceUrl,
    })),
  } as unknown as import('../../src/domain/competitor/pattern-types.js').CompetitorPatternPackage;
}
