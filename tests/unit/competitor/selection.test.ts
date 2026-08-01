import { describe, expect, it } from 'vitest';
import { selectCompetitors } from '../../../src/domain/competitor/selection.js';
import { cand, candAtKm, prospect } from './helpers.js';

const strong = { secondaryCategories: ['teeth whitening', 'implants', 'invisalign'] }; // 3 service matches → 95

describe('selectCompetitors — exclusion & dedup', () => {
  it('excludes the prospect itself from its own competitor set', () => {
    const res = selectCompetitors(prospect(), [
      candAtKm(1, { rowIndex: 1, website: 'https://smileclinic.example', ...strong }),
      candAtKm(2, { rowIndex: 2, ...strong }),
      candAtKm(3, { rowIndex: 3, ...strong }),
    ]);
    const self = res.candidates.find((c) => c.input.rowIndex === 1);
    expect(self?.disposition).toBe('REJECTED');
    expect(self?.rejectionReason).toBe('PROSPECT_SELF');
  });

  it('removes duplicate domains (URL variants) keeping the first', () => {
    const res = selectCompetitors(prospect(), [
      candAtKm(1, { rowIndex: 1, website: 'https://acme-dental.example', ...strong }),
      candAtKm(2, { rowIndex: 2, website: 'http://www.acme-dental.example/', ...strong }),
    ]);
    const dup = res.candidates.find((c) => c.input.rowIndex === 2);
    expect(dup?.rejectionReason).toBe('DUPLICATE_DOMAIN');
  });

  it('removes duplicate provider ids', () => {
    const res = selectCompetitors(prospect(), [
      candAtKm(1, { rowIndex: 1, providerCandidateId: 'p-1', website: 'https://a.example', ...strong }),
      candAtKm(2, { rowIndex: 2, providerCandidateId: 'p-1', website: 'https://b.example', ...strong }),
    ]);
    expect(res.candidates.find((c) => c.input.rowIndex === 2)?.rejectionReason).toBe('DUPLICATE_PROVIDER_ID');
  });

  it('excludes an alternate branch of the prospect (same registrable domain)', () => {
    const res = selectCompetitors(prospect(), [candAtKm(1, { rowIndex: 1, website: 'https://chelsea.smileclinic.example', ...strong })]);
    expect(res.candidates[0]?.rejectionReason).toBe('PROSPECT_BRANCH');
  });
});

describe('selectCompetitors — branch/chain rules', () => {
  it('selects at most one branch per parent brand and never lets a chain dominate', () => {
    const res = selectCompetitors(prospect(), [
      candAtKm(1, { website: 'https://chainco-a.example', parentBrand: 'ChainCo', ...strong }),
      candAtKm(2, { website: 'https://chainco-b.example', parentBrand: 'ChainCo', ...strong }),
      candAtKm(3, { website: 'https://chainco-c.example', parentBrand: 'ChainCo', ...strong }),
      candAtKm(4, { website: 'https://indep-1.example', ...strong }),
      candAtKm(4.5, { website: 'https://indep-2.example', ...strong }),
    ]);
    expect(res.selected).toHaveLength(3);
    const chainSelected = res.selected.filter((c) => c.normalizedParentBrand === 'chainco');
    expect(chainSelected).toHaveLength(1);
    const brandLimited = res.candidates.filter((c) => c.rejectionReason === 'CHAIN_BRANCH_LIMIT');
    expect(brandLimited).toHaveLength(2);
  });
});

describe('selectCompetitors — ranking, cap, outcomes', () => {
  it('ranks by score desc then distance asc and caps at three', () => {
    const res = selectCompetitors(prospect(), [
      candAtKm(1, { website: 'https://a.example', ...strong }),
      candAtKm(2, { website: 'https://b.example', ...strong }),
      candAtKm(3, { website: 'https://c.example', ...strong }),
      candAtKm(4, { website: 'https://d.example', ...strong }),
    ]);
    expect(res.selected.map((c) => c.acceptanceRank)).toEqual([1, 2, 3]);
    // all score 95; tiebreak = distance asc → closest three selected, farthest NOT_SELECTED
    expect(res.selected.map((c) => c.normalizedDomain)).toEqual(['a.example', 'b.example', 'c.example']);
    expect(res.candidates.find((c) => c.normalizedDomain === 'd.example')?.rejectionReason).toBe('NOT_SELECTED');
    expect(res.outcome).toBe('RESEARCHED');
  });

  it('treats fewer than two valid competitors as a valid outcome (not a failure)', () => {
    const res = selectCompetitors(prospect(), [
      candAtKm(1, { website: 'https://only.example', ...strong }),
      candAtKm(2, { website: 'https://weak.example', primaryCategory: 'restaurant' }),
    ]);
    expect(res.acceptedCount).toBe(1);
    expect(res.outcome).toBe('INSUFFICIENT_COMPARABLE');
  });

  it('reports NO_CANDIDATES_FOUND for an empty input set', () => {
    const res = selectCompetitors(prospect(), []);
    expect(res.outcome).toBe('NO_CANDIDATES_FOUND');
    expect(res.selected).toHaveLength(0);
  });
});

describe('selectCompetitors — radius fallback', () => {
  it('stays at the 5 km primary radius when two valid competitors exist inside it', () => {
    const res = selectCompetitors(prospect(), [
      candAtKm(1, { website: 'https://a.example', ...strong }),
      candAtKm(2, { website: 'https://b.example', ...strong }),
      candAtKm(7, { website: 'https://far.example', ...strong }),
    ]);
    expect(res.activeRadius).toBe('PRIMARY_5KM');
    expect(res.candidates.find((c) => c.normalizedDomain === 'far.example')?.rejectionReason).toBe('OUT_OF_RADIUS');
  });

  it('expands to 10 km only when fewer than two valid competitors are inside 5 km', () => {
    const res = selectCompetitors(prospect(), [
      candAtKm(7, { website: 'https://a.example', ...strong }),
      candAtKm(8, { website: 'https://b.example', ...strong }),
      candAtKm(11, { website: 'https://c.example', ...strong }),
    ]);
    expect(res.activeRadius).toBe('FALLBACK_10KM');
    expect(res.acceptedCount).toBe(2); // both 7/8 km accepted at proximity=8
    expect(res.candidates.find((c) => c.normalizedDomain === 'c.example')?.rejectionReason).toBe('OUT_OF_RADIUS');
    expect(res.outcome).toBe('RESEARCHED');
  });
});

describe('selectCompetitors — determinism', () => {
  it('produces identical results across repeated evaluation of identical input', () => {
    const inputs = [candAtKm(1, { website: 'https://a.example', ...strong }), candAtKm(2, { website: 'https://b.example', ...strong })];
    const a = selectCompetitors(prospect(), inputs);
    const b = selectCompetitors(prospect(), inputs);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('never marks a duplicate or gate rejection as accepted (single-candidate ⇒ no sample-of-one selection ≥2)', () => {
    const res = selectCompetitors(prospect(), [cand({ ...strong, latitude: 51.5, longitude: -0.13 })]);
    expect(res.acceptedCount).toBeLessThanOrEqual(1);
    expect(res.outcome).not.toBe('RESEARCHED');
  });
});
