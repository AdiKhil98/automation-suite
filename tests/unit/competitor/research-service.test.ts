import { describe, expect, it } from 'vitest';
import {
  CompetitorResearchService,
  type CompetitorResearchStore,
  type CompetitorResearchTxRepos,
  type CompetitorResearchUnitOfWork,
  type ExistingRunRef,
  type NewCompetitorCandidate,
  type NewCompetitorResearchRun,
} from '../../../src/domain/competitor/research-service.js';
import { candAtKm, prospect } from './helpers.js';

const strong = { secondaryCategories: ['teeth whitening', 'implants', 'invisalign'] };

class FakeStore implements CompetitorResearchStore {
  runs: NewCompetitorResearchRun[] = [];
  candidates: NewCompetitorCandidate[] = [];
  supersedeCalls = 0;

  findRunByHashes(leadId: string, inputHash: string, configHash: string): Promise<ExistingRunRef | null> {
    const found = this.runs.find((r) => r.leadId === leadId && r.inputHash === inputHash && r.configHash === configHash);
    return Promise.resolve(found ? { id: found.id, version: found.version, outcome: found.outcome, status: found.status } : null);
  }
  maxVersionForLead(leadId: string): Promise<number> {
    return Promise.resolve(this.runs.filter((r) => r.leadId === leadId).reduce((m, r) => Math.max(m, r.version), 0));
  }
  supersedePriorDraftRuns(): Promise<void> {
    this.supersedeCalls += 1;
    return Promise.resolve();
  }
  insertRun(run: NewCompetitorResearchRun): Promise<void> {
    this.runs.push(run);
    return Promise.resolve();
  }
  insertCandidates(rows: NewCompetitorCandidate[]): Promise<void> {
    this.candidates.push(...rows);
    return Promise.resolve();
  }
}

class FakeUow implements CompetitorResearchUnitOfWork {
  constructor(readonly store: FakeStore) {}
  transaction<T>(fn: (repos: CompetitorResearchTxRepos) => Promise<T>): Promise<T> {
    return fn({ research: this.store });
  }
}

const candidates = [
  candAtKm(1, { rowIndex: 1, website: 'https://a.example', ...strong }),
  candAtKm(2, { rowIndex: 2, website: 'https://b.example', ...strong }),
];

describe('CompetitorResearchService', () => {
  it('dry run performs ZERO writes', async () => {
    const store = new FakeStore();
    const svc = new CompetitorResearchService(new FakeUow(store));
    const res = await svc.run(prospect(), candidates, { provider: 'fixture', apply: false });
    expect(res.persisted).toBe(false);
    expect(store.runs).toHaveLength(0);
    expect(store.candidates).toHaveLength(0);
    expect(res.selection.outcome).toBe('RESEARCHED');
  });

  it('apply persists a DRAFT run + candidates as version 1', async () => {
    const store = new FakeStore();
    const svc = new CompetitorResearchService(new FakeUow(store));
    const res = await svc.run(prospect(), candidates, { provider: 'fixture', apply: true });
    expect(res.persisted).toBe(true);
    expect(res.version).toBe(1);
    expect(store.runs[0]?.status).toBe('DRAFT');
    expect(store.candidates.length).toBe(res.selection.candidates.length);
  });

  it('repeated identical apply is idempotent (reuses the run, no duplicate)', async () => {
    const store = new FakeStore();
    const svc = new CompetitorResearchService(new FakeUow(store));
    await svc.run(prospect(), candidates, { provider: 'fixture', apply: true });
    const second = await svc.run(prospect(), candidates, { provider: 'fixture', apply: true });
    expect(second.reusedExisting).toBe(true);
    expect(second.persisted).toBe(false);
    expect(store.runs).toHaveLength(1);
  });

  it('materially changed input creates version 2 and supersedes prior drafts', async () => {
    const store = new FakeStore();
    const svc = new CompetitorResearchService(new FakeUow(store));
    await svc.run(prospect(), candidates, { provider: 'fixture', apply: true });
    const changed = [...candidates, candAtKm(3, { rowIndex: 3, website: 'https://c.example', ...strong })];
    const res = await svc.run(prospect(), changed, { provider: 'fixture', apply: true });
    expect(res.version).toBe(2);
    expect(store.runs).toHaveLength(2);
    // supersession runs before every insert (a harmless no-op on the first); prior runs are never deleted.
    expect(store.supersedeCalls).toBe(2);
    expect(store.runs.every((r) => r.status === 'DRAFT')).toBe(true);
  });
});
