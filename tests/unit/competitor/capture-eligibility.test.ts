import { describe, expect, it } from 'vitest';
import { evaluateEligibility, type SelectedCompetitorInput } from '../../../src/domain/competitor/capture-eligibility.js';

const accepted = (domain: string | null): SelectedCompetitorInput => ({
  competitorCandidateId: 'cand-1',
  disposition: 'ACCEPTED',
  normalizedDomain: domain,
});

describe('evaluateEligibility', () => {
  it('accepts a selected competitor with a valid domain and derives the origin from the stored domain', () => {
    const r = evaluateEligibility(accepted('competitor-a.de'), 'prospect.de');
    expect(r.eligible).toBe(true);
    expect(r.originUrl).toBe('https://competitor-a.de');
    expect(r.normalizedOrigin).toBe('competitor-a.de');
  });

  it('rejects a non-selected (rejected) candidate', () => {
    const r = evaluateEligibility({ ...accepted('x.de'), disposition: 'REJECTED' }, 'p.de');
    expect(r).toMatchObject({ eligible: false, reason: 'NOT_SELECTED' });
  });

  it('rejects the prospect\'s own domain (self-exclusion, PSL-aware)', () => {
    const r = evaluateEligibility(accepted('prospect.de'), 'www.prospect.de');
    expect(r).toMatchObject({ eligible: false, reason: 'PROSPECT_DOMAIN' });
  });

  it('rejects a directory / marketplace / social-only origin', () => {
    expect(evaluateEligibility(accepted('yelp.com'), 'p.de').reason).toBe('NON_ELIGIBLE_LISTING');
    expect(evaluateEligibility(accepted('facebook.com'), 'p.de').reason).toBe('NON_ELIGIBLE_LISTING');
  });

  it('rejects a missing/invalid website', () => {
    expect(evaluateEligibility(accepted(null), 'p.de').reason).toBe('INVALID_WEBSITE');
  });

  it('rejects an arbitrary supplied origin that does not match the stored candidate domain (no silent substitution)', () => {
    const r = evaluateEligibility(accepted('competitor-a.de'), 'p.de', 'https://attacker.example');
    expect(r).toMatchObject({ eligible: false, reason: 'ORIGIN_SUBSTITUTION_REJECTED' });
  });

  it('honors a supplied origin only when it resolves to the same registrable domain', () => {
    const r = evaluateEligibility(accepted('competitor-a.de'), 'p.de', 'https://www.competitor-a.de/contact');
    expect(r.eligible).toBe(true);
  });
});
