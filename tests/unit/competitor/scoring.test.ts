import { describe, expect, it } from 'vitest';
import { prepareProspect, scoreCandidate } from '../../../src/domain/competitor/scoring.js';
import { cand, candAtKm, prospect } from './helpers.js';

const P = prepareProspect(prospect());

describe('scoreCandidate — approved sanity examples (exact 100-point model)', () => {
  it('scores 95 and ACCEPTS (exact + 3 services + <=5km + same type + market + language)', () => {
    const r = scoreCandidate(P, candAtKm(3, { secondaryCategories: ['teeth whitening', 'implants', 'invisalign'] }), 5);
    expect(r.comparabilityScore).toBe(95);
    expect(r.categoryMatch).toBe('EXACT');
    expect(r.confidence).toBe('HIGH');
    expect(r.disposition).toBe('ACCEPTED');
  });

  it('scores 60 and REJECTS BELOW_THRESHOLD (exact + no services + <=5km + unknown type/market/language)', () => {
    const r = scoreCandidate(P, candAtKm(3, { secondaryCategories: [], businessType: null, market: null, language: null }), 5);
    expect(r.comparabilityScore).toBe(60);
    expect(r.disposition).toBe('REJECTED');
    expect(r.rejectionReason).toBe('BELOW_THRESHOLD');
    // category (45) + proximity (15) alone cannot reach 70 — geography alone can never qualify.
    expect(r.confidence).toBe('LOW');
  });

  it('scores exactly 70 and ACCEPTS at the boundary (confidence MEDIUM)', () => {
    const r = scoreCandidate(P, candAtKm(3, { secondaryCategories: [], businessType: 'independent', market: null, language: null }), 5);
    expect(r.comparabilityScore).toBe(70);
    expect(r.disposition).toBe('ACCEPTED');
    expect(r.confidence).toBe('MEDIUM');
  });

  it('scores 80 and ACCEPTS a related-category candidate with 4 service matches', () => {
    const r = scoreCandidate(
      P,
      candAtKm(3, { primaryCategory: 'orthodontist', secondaryCategories: ['teeth whitening', 'implants', 'invisalign', 'veneers'] }),
      5,
    );
    expect(r.comparabilityScore).toBe(80);
    expect(r.categoryMatch).toBe('RELATED');
    expect(r.disposition).toBe('ACCEPTED');
  });
});

describe('scoreCandidate — gates', () => {
  it('rejects WEAK category before scoring', () => {
    const r = scoreCandidate(P, candAtKm(3, { primaryCategory: 'restaurant' }), 5);
    expect(r.rejectionReason).toBe('WEAK_CATEGORY_MATCH');
    expect(r.comparabilityScore).toBeNull();
  });

  it('rejects a related candidate lacking meaningful service overlap', () => {
    const r = scoreCandidate(P, candAtKm(3, { primaryCategory: 'orthodontist', secondaryCategories: ['teeth whitening'] }), 5);
    expect(r.rejectionReason).toBe('INSUFFICIENT_SERVICE_OVERLAP');
  });

  it('rejects missing coordinates (no silent acceptance of unknown geography)', () => {
    const r = scoreCandidate(P, cand({ latitude: null, longitude: null }), 5);
    expect(r.rejectionReason).toBe('MISSING_COORDINATES');
  });

  it('rejects a candidate outside the active radius', () => {
    const r = scoreCandidate(P, candAtKm(6.7), 5);
    expect(r.rejectionReason).toBe('OUT_OF_RADIUS');
  });

  it('rejects a confirmed different market before scoring', () => {
    const r = scoreCandidate(P, candAtKm(3, { market: 'manchester' }), 5);
    expect(r.rejectionReason).toBe('MARKET_MISMATCH');
  });

  it('does NOT reject on a language mismatch (language is never a gate)', () => {
    const r = scoreCandidate(P, candAtKm(3, { secondaryCategories: ['teeth whitening', 'implants', 'invisalign'], language: 'de' }), 5);
    expect(r.disposition).toBe('ACCEPTED');
    expect(r.comparabilityScore).toBe(91);
  });

  it('rejects the prospect itself (same normalized domain)', () => {
    const r = scoreCandidate(P, candAtKm(3, { website: 'http://www.smileclinic.example/contact' }), 5);
    expect(r.rejectionReason).toBe('PROSPECT_SELF');
  });

  it('rejects a candidate with no valid website', () => {
    const r = scoreCandidate(P, candAtKm(3, { website: null }), 5);
    expect(r.rejectionReason).toBe('INVALID_WEBSITE');
  });

  it('rejects directory/social-only listings deterministically', () => {
    const r = scoreCandidate(P, candAtKm(3, { website: 'https://facebook.com/somebiz' }), 5);
    expect(r.rejectionReason).toBe('NON_ELIGIBLE_LISTING');
  });
});

describe('scoreCandidate — business-type points', () => {
  it('awards 5 points for a known independent-vs-chain mismatch (not disqualifying)', () => {
    const r = scoreCandidate(P, candAtKm(3, { secondaryCategories: [], businessType: 'chain' }), 5);
    const bt = r.scoreBreakdown.find((c) => c.component === 'BUSINESS_TYPE');
    expect(bt?.points).toBe(5);
    // exact45 + 0 svc + prox15 + businessType5 + market6 + lang4 = 75
    expect(r.comparabilityScore).toBe(75);
    expect(r.disposition).toBe('ACCEPTED');
  });
});
