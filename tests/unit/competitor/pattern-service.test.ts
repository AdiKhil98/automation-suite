import { describe, expect, it } from 'vitest';
import {
  CompetitorPatternService,
  type CompetitorPatternStore,
  type CompetitorPatternUnitOfWork,
  type NewContrastRow,
  type NewPatternEvidenceRefRow,
  type NewPatternPackageRow,
  type NewPatternRow,
} from '../../../src/domain/competitor/pattern-service.js';
import { buildInput, comp, ev, prospect, pref } from './pattern-helpers.js';

class MemStore implements CompetitorPatternStore {
  packages: NewPatternPackageRow[] = [];
  patterns: NewPatternRow[] = [];
  contrasts: NewContrastRow[] = [];
  refs: NewPatternEvidenceRefRow[] = [];
  async findPackageByHashes(leadId: string, inputHash: string, configHash: string) {
    const p = this.packages.find((x) => x.leadId === leadId && x.inputHash === inputHash && x.configHash === configHash);
    return p ? { id: p.id, version: p.version, status: p.status } : null;
  }
  async maxVersionForLead(leadId: string) {
    return this.packages.filter((x) => x.leadId === leadId).reduce((m, x) => Math.max(m, x.version), 0);
  }
  async supersedePriorDraftPackages(leadId: string, newId: string) {
    for (const p of this.packages) if (p.leadId === leadId && p.id !== newId && p.status === 'DRAFT') (p.status as string) = 'SUPERSEDED';
  }
  async insertPackage(row: NewPatternPackageRow) { this.packages.push(row); }
  async insertPatterns(rows: NewPatternRow[]) { this.patterns.push(...rows); }
  async insertContrasts(rows: NewContrastRow[]) { this.contrasts.push(...rows); }
  async insertEvidenceRefs(rows: NewPatternEvidenceRefRow[]) { this.refs.push(...rows); }
}

function uowFor(store: MemStore): CompetitorPatternUnitOfWork {
  return { async transaction(fn) { return fn({ pattern: store }); } };
}

const booking = (id: string, brand: string) => comp({ competitorCandidateId: id, brandKey: brand, evidence: [ev({ evidenceCategory: 'BOOKING_CTA_VISIBLE' })] });

describe('CompetitorPatternService', () => {
  it('build() produces a DRAFT package and writes nothing', async () => {
    const store = new MemStore();
    const service = new CompetitorPatternService({ uow: uowFor(store) });
    const input = buildInput([booking('a', 'A'), booking('b', 'B')], prospect([pref('tel')]));
    const { package: pkg, validation } = service.build(input);
    expect(pkg.status).toBe('DRAFT');
    expect(validation.ok).toBe(true);
    expect(pkg.confidence).toBe('MEDIUM'); // denominator 2 → at most MEDIUM
    expect(store.packages.length).toBe(0);
  });

  it('dry run (apply=false) persists nothing', async () => {
    const store = new MemStore();
    const service = new CompetitorPatternService({ uow: uowFor(store) });
    const res = await service.run(buildInput([booking('a', 'A'), booking('b', 'B')]), false);
    expect(res.persisted).toBe(false);
    expect(store.packages.length).toBe(0);
  });

  it('apply persists a DRAFT package + patterns + contrasts + refs', async () => {
    const store = new MemStore();
    const service = new CompetitorPatternService({ uow: uowFor(store) });
    // A contrast requires an EXPLICIT verified prospect negative (not a missing primitive).
    const p = prospect([pref('tel')], { negatives: [{ category: 'BOOKING_CTA_VISIBLE', inspectionScope: 'mobile-initial-viewport', evidenceRef: 'prospect-neg-1' }] });
    const input = buildInput([booking('a', 'A'), booking('b', 'B')], p);
    const res = await service.run(input, true);
    expect(res.persisted).toBe(true);
    expect(res.version).toBe(1);
    expect(store.packages[0]?.status).toBe('DRAFT');
    expect(store.patterns.length).toBeGreaterThan(0);
    expect(store.contrasts.length).toBe(1); // booking contrast (explicit prospect negative)
    expect(store.refs.length).toBeGreaterThan(0);
  });

  it('identical generation is idempotent (same version reused, no duplicate)', async () => {
    const store = new MemStore();
    const service = new CompetitorPatternService({ uow: uowFor(store) });
    const input = buildInput([booking('a', 'A'), booking('b', 'B')]);
    const first = await service.run(input, true);
    const second = await service.run(input, true);
    expect(second.reusedExisting).toBe(true);
    expect(second.version).toBe(first.version);
    expect(store.packages.length).toBe(1);
  });

  it('a materially changed eligible evidence set creates a new immutable version', async () => {
    const store = new MemStore();
    const service = new CompetitorPatternService({ uow: uowFor(store) });
    await service.run(buildInput([booking('a', 'A'), booking('b', 'B')]), true);
    // Add a third present brand → different eligible evidence set → new input hash → new version.
    const changed = buildInput([booking('a', 'A'), booking('b', 'B'), booking('c', 'C')]);
    const res2 = await service.run(changed, true);
    expect(res2.reusedExisting).toBe(false);
    expect(res2.version).toBe(2);
    expect(store.packages.length).toBe(2);
    expect(store.packages.find((p) => p.version === 1)?.status).toBe('SUPERSEDED');
  });

  it('hashing is stable and deterministic for the same input', () => {
    const service = new CompetitorPatternService({ uow: uowFor(new MemStore()) });
    const input = buildInput([booking('a', 'A'), booking('b', 'B')]);
    const a = service.build(input).package;
    const b = service.build(input).package;
    expect(a.inputHash).toBe(b.inputHash);
    expect(a.packageHash).toBe(b.packageHash);
    expect(a.configHash).toBe(b.configHash);
  });
});
