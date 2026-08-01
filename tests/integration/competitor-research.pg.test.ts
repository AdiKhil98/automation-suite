import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { requireIntegrationTestDatabase } from '../support/test-database.js';
import { CompetitorResearchService } from '../../src/domain/competitor/research-service.js';
import { DrizzleCompetitorResearchUnitOfWork } from '../../src/persistence/competitor-research-unit-of-work.js';
import { CompetitorResearchRepository } from '../../src/persistence/repositories/competitor-research.repo.js';
import { type DbHandle } from '../../src/persistence/db.js';
import { leads } from '../../src/persistence/schema.js';
import { type CompetitorInputCandidate, type ProspectProfileInput } from '../../src/domain/competitor/types.js';

const testDatabase = requireIntegrationTestDatabase();

const PROSPECT_LAT = 51.5074;
const PROSPECT_LON = -0.1278;
const strong = ['teeth whitening', 'implants', 'invisalign'];

function candidate(rowIndex: number, domain: string, km: number): CompetitorInputCandidate {
  return {
    rowIndex, providerCandidateId: null, businessName: `Biz ${String(rowIndex)}`, website: `https://${domain}`,
    primaryCategory: 'dentist', secondaryCategories: strong, latitude: PROSPECT_LAT + km / 111.19, longitude: PROSPECT_LON,
    address: null, city: 'London', market: 'london', language: 'en', businessType: 'independent', parentBrand: null, branchId: null,
  };
}

describe('competitor research persistence (PostgreSQL)', () => {
  let handle: DbHandle;

  beforeEach(async () => {
    handle ??= testDatabase.createHandle();
    await testDatabase.truncate(handle.db);
  });

  afterAll(async () => {
    if (handle) await handle.pool.end();
  });

  async function seedLead(): Promise<string> {
    const id = randomUUID();
    await handle.db.insert(leads).values({ id, normalizedDomain: 'smileclinic.example', status: 'OPPORTUNITY_READY' });
    return id;
  }

  function profile(leadId: string): ProspectProfileInput {
    return {
      leadId, website: 'https://smileclinic.example', primaryCategory: 'dentist', secondaryCategories: strong,
      latitude: PROSPECT_LAT, longitude: PROSPECT_LON, city: 'London', market: 'london', language: 'en',
      businessType: 'independent', parentBrand: null,
    };
  }

  it('persists a DRAFT run + candidates and is idempotent on identical re-apply', async () => {
    const leadId = await seedLead();
    const svc = new CompetitorResearchService(new DrizzleCompetitorResearchUnitOfWork(handle.db));
    const repo = new CompetitorResearchRepository(handle.db);
    const candidates = [candidate(1, 'a.example', 1), candidate(2, 'b.example', 2), candidate(3, 'c.example', 3)];

    const first = await svc.run(profile(leadId), candidates, { provider: 'fixture', apply: true });
    expect(first.persisted).toBe(true);
    expect(first.version).toBe(1);

    const runs = await repo.listRunsForLead(leadId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('DRAFT');
    expect(runs[0]?.outcome).toBe('RESEARCHED');
    const rows = await repo.getCandidates(runs[0]?.id ?? '');
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.disposition === 'ACCEPTED')).toHaveLength(3);

    const second = await svc.run(profile(leadId), candidates, { provider: 'fixture', apply: true });
    expect(second.reusedExisting).toBe(true);
    expect(await repo.listRunsForLead(leadId)).toHaveLength(1);
  });

  it('creates an immutable version 2 and supersedes the prior DRAFT on changed input', async () => {
    const leadId = await seedLead();
    const svc = new CompetitorResearchService(new DrizzleCompetitorResearchUnitOfWork(handle.db));
    const repo = new CompetitorResearchRepository(handle.db);
    await svc.run(profile(leadId), [candidate(1, 'a.example', 1), candidate(2, 'b.example', 2)], { provider: 'fixture', apply: true });
    await svc.run(profile(leadId), [candidate(1, 'a.example', 1), candidate(2, 'b.example', 2), candidate(3, 'c.example', 3)], { provider: 'fixture', apply: true });

    const runs = await repo.listRunsForLead(leadId);
    expect(runs).toHaveLength(2);
    const v1 = runs.find((r) => r.version === 1);
    const v2 = runs.find((r) => r.version === 2);
    expect(v1?.status).toBe('SUPERSEDED');
    expect(v1?.supersededBy).toBe(v2?.id);
    expect(v2?.status).toBe('DRAFT');
  });
});
