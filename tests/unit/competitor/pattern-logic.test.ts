import { describe, expect, it } from 'vitest';
import { computePatterns, depthContrastAllowed, median } from '../../../src/domain/competitor/pattern-logic.js';
import { type EvidenceCategory } from '../../../src/domain/competitor/evidence-types.js';
import { buildInput, comp, ev, negEv, noProspect, pref, prospect, STALE_AT } from './pattern-helpers.js';

const patternFor = (res: ReturnType<typeof computePatterns>, cat: EvidenceCategory) => {
  const p = res.patterns.find((x) => x.category === cat);
  if (!p) throw new Error(`no pattern for ${cat}`);
  return p;
};

const withBooking = (id: string, brand: string) => comp({ competitorCandidateId: id, brandKey: brand, evidence: [ev({ evidenceCategory: 'BOOKING_CTA_VISIBLE' })] });

describe('computePatterns — denominator + presence rules', () => {
  it('two-of-two present → ALL_OBSERVED with exact counts', () => {
    const res = computePatterns(buildInput([withBooking('a', 'A'), withBooking('b', 'B')]));
    const p = patternFor(res, 'BOOKING_CTA_VISIBLE');
    expect(p.result).toBe('ALL_OBSERVED');
    expect(p.presentCount).toBe(2);
    expect(p.absentCount).toBe(0);
    expect(p.usableDenominator).toBe(2);
    expect(p.participatingCompetitorIds.sort()).toEqual(['a', 'b']);
  });

  it('two-of-three present → MAJORITY_OBSERVED (third verified ABSENT via explicit negative)', () => {
    // The third brand carries an EXPLICIT, scoped negative for the ABSENT-capable booking category.
    const absentBrand = comp({ competitorCandidateId: 'c', brandKey: 'C', evidence: [negEv('BOOKING_CTA_VISIBLE')] });
    const res = computePatterns(buildInput([withBooking('a', 'A'), withBooking('b', 'B'), absentBrand]));
    const p = patternFor(res, 'BOOKING_CTA_VISIBLE');
    expect(p.result).toBe('MAJORITY_OBSERVED');
    expect(p.presentCount).toBe(2);
    expect(p.absentCount).toBe(1);
    expect(p.unknownCount).toBe(0);
    expect(p.usableDenominator).toBe(3);
  });

  it('one-of-two present with one explicit ABSENT → NO_PATTERN', () => {
    const absentBrand = comp({ competitorCandidateId: 'b', brandKey: 'B', evidence: [negEv('BOOKING_CTA_VISIBLE')] });
    const res = computePatterns(buildInput([withBooking('a', 'A'), absentBrand]));
    const p = patternFor(res, 'BOOKING_CTA_VISIBLE');
    expect(p.presentCount).toBe(1);
    expect(p.absentCount).toBe(1);
    expect(p.result).toBe('NO_PATTERN');
  });

  it('denominator below two → INSUFFICIENT_DATA (sample of one blocked)', () => {
    const res = computePatterns(buildInput([withBooking('a', 'A')]));
    const p = patternFor(res, 'BOOKING_CTA_VISIBLE');
    expect(p.result).toBe('INSUFFICIENT_DATA');
    expect(p.usableDenominator).toBe(1);
  });

  it('missing capture → UNKNOWN, never ABSENT (excluded from denominator)', () => {
    const notCaptured = comp({ competitorCandidateId: 'b', brandKey: 'B', capturedOk: false, evidence: [] });
    const res = computePatterns(buildInput([withBooking('a', 'A'), notCaptured]));
    const p = patternFor(res, 'BOOKING_CTA_VISIBLE');
    expect(p.unknownCount).toBe(1);
    expect(p.absentCount).toBe(0);
    expect(p.usableDenominator).toBe(1);
    expect(p.result).toBe('INSUFFICIENT_DATA');
  });

  it('distinct-brand counting: two branches of one brand count once', () => {
    const res = computePatterns(buildInput([withBooking('a1', 'A'), withBooking('a2', 'A')]));
    const p = patternFor(res, 'BOOKING_CTA_VISIBLE');
    expect(p.totalSelected).toBe(1);
    expect(p.usableDenominator).toBe(1);
    expect(p.result).toBe('INSUFFICIENT_DATA');
  });
});

describe('computePatterns — verified-absence semantics (explicit negatives only)', () => {
  it('no evidence row for a category → UNKNOWN, never ABSENT', () => {
    const noBooking = comp({ competitorCandidateId: 'b', brandKey: 'B', capturedOk: true, evidence: [ev({ evidenceCategory: 'PHONE_VISIBLE' })] });
    const res = computePatterns(buildInput([withBooking('a', 'A'), noBooking]));
    const p = patternFor(res, 'BOOKING_CTA_VISIBLE');
    expect(p.absentCount).toBe(0);
    expect(p.unknownCount).toBe(1);
  });

  it('successful bounded capture without category evidence stays UNKNOWN', () => {
    // capturedOk is true, but there is NO booking item and NO explicit negative → UNKNOWN.
    const captured = comp({ competitorCandidateId: 'b', brandKey: 'B', capturedOk: true, evidence: [] });
    const res = computePatterns(buildInput([withBooking('a', 'A'), captured]));
    expect(patternFor(res, 'BOOKING_CTA_VISIBLE').unknownCount).toBe(1);
    expect(patternFor(res, 'BOOKING_CTA_VISIBLE').absentCount).toBe(0);
  });

  it('an explicit, scoped negative for an ABSENT-capable category becomes ABSENT', () => {
    const absent = comp({ competitorCandidateId: 'b', brandKey: 'B', evidence: [negEv('PHONE_VISIBLE')] });
    const res = computePatterns(buildInput([comp({ competitorCandidateId: 'a', brandKey: 'A', evidence: [ev({ evidenceCategory: 'PHONE_VISIBLE' })] }), absent]));
    const p = patternFor(res, 'PHONE_VISIBLE');
    expect(p.absentCount).toBe(1);
    expect(p.presentCount).toBe(1);
    expect(p.unknownCount).toBe(0);
  });

  it('an explicit negative for a NON-ABSENT-capable category stays UNKNOWN (no site-wide inference)', () => {
    // OPENING_HOURS_VISIBLE cannot be proven absent from a bounded capture → UNKNOWN even with a negative.
    const absent = comp({ competitorCandidateId: 'b', brandKey: 'B', evidence: [negEv('OPENING_HOURS_VISIBLE')] });
    const present = comp({ competitorCandidateId: 'a', brandKey: 'A', evidence: [ev({ evidenceCategory: 'OPENING_HOURS_VISIBLE' })] });
    const res = computePatterns(buildInput([present, absent]));
    const p = patternFor(res, 'OPENING_HOURS_VISIBLE');
    expect(p.absentCount).toBe(0);
    expect(p.unknownCount).toBe(1);
  });

  it('an uncaptured relevant page cannot support ABSENT (no evidence, no negative → UNKNOWN)', () => {
    const uncaptured = comp({ competitorCandidateId: 'b', brandKey: 'B', capturedOk: false, evidence: [] });
    const res = computePatterns(buildInput([withBooking('a', 'A'), uncaptured]));
    expect(patternFor(res, 'BOOKING_CTA_VISIBLE').absentCount).toBe(0);
    expect(patternFor(res, 'BOOKING_CTA_VISIBLE').unknownCount).toBe(1);
  });

  it('site-wide absence is not inferred from a homepage-only capture with unrelated evidence', () => {
    // Both brands captured a homepage with only a phone control; nothing proves booking/hours absence.
    const a = comp({ competitorCandidateId: 'a', brandKey: 'A', capturedOk: true, evidence: [ev({ evidenceCategory: 'PHONE_VISIBLE' })] });
    const b = comp({ competitorCandidateId: 'b', brandKey: 'B', capturedOk: true, evidence: [ev({ evidenceCategory: 'PHONE_VISIBLE' })] });
    const res = computePatterns(buildInput([a, b]));
    for (const cat of ['BOOKING_CTA_VISIBLE', 'OPENING_HOURS_VISIBLE', 'FAQ_CONTENT_VISIBLE'] as const) {
      const p = patternFor(res, cat);
      expect(p.absentCount).toBe(0);
      expect(p.unknownCount).toBe(2);
    }
  });
});

describe('computePatterns — evidence eligibility affects classification', () => {
  it('stale evidence is excluded → competitor becomes UNKNOWN for that category', () => {
    const stale = comp({ competitorCandidateId: 'b', brandKey: 'B', capturedOk: true, evidence: [ev({ evidenceCategory: 'BOOKING_CTA_VISIBLE', capturedAt: STALE_AT })] });
    const res = computePatterns(buildInput([withBooking('a', 'A'), stale]));
    const p = patternFor(res, 'BOOKING_CTA_VISIBLE');
    expect(p.presentCount).toBe(1);
    expect(p.unknownCount).toBe(1); // stale category item → UNKNOWN, not ABSENT
    expect(p.absentCount).toBe(0);
  });

  it('LOW-confidence evidence excluded → UNKNOWN', () => {
    const low = comp({ competitorCandidateId: 'b', brandKey: 'B', capturedOk: true, evidence: [ev({ evidenceCategory: 'BOOKING_CTA_VISIBLE', confidence: 'LOW' })] });
    const res = computePatterns(buildInput([withBooking('a', 'A'), low]));
    expect(patternFor(res, 'BOOKING_CTA_VISIBLE').unknownCount).toBe(1);
  });

  it('unsafe (safeForOutreach=false) evidence excluded → UNKNOWN', () => {
    const unsafe = comp({ competitorCandidateId: 'b', brandKey: 'B', capturedOk: true, evidence: [ev({ evidenceCategory: 'BOOKING_CTA_VISIBLE', safeForOutreach: false })] });
    const res = computePatterns(buildInput([withBooking('a', 'A'), unsafe]));
    expect(patternFor(res, 'BOOKING_CTA_VISIBLE').unknownCount).toBe(1);
  });

  it('inactive evidence excluded → UNKNOWN', () => {
    const inactive = comp({ competitorCandidateId: 'b', brandKey: 'B', capturedOk: true, evidence: [ev({ evidenceCategory: 'BOOKING_CTA_VISIBLE', active: false })] });
    const res = computePatterns(buildInput([withBooking('a', 'A'), inactive]));
    expect(patternFor(res, 'BOOKING_CTA_VISIBLE').unknownCount).toBe(1);
  });

  it('superseded capture excludes the competitor entirely (not in denominator)', () => {
    const superseded = comp({ competitorCandidateId: 'b', brandKey: 'B', captureActive: false, evidence: [ev({ evidenceCategory: 'BOOKING_CTA_VISIBLE' })] });
    const res = computePatterns(buildInput([withBooking('a', 'A'), superseded]));
    const p = patternFor(res, 'BOOKING_CTA_VISIBLE');
    expect(p.totalSelected).toBe(1);
    expect(res.exclusions.some((e) => e.reason === 'CAPTURE_SUPERSEDED')).toBe(true);
  });

  it('only SELECTED competitor evidence is used', () => {
    const notSelected = comp({ competitorCandidateId: 'b', brandKey: 'B', selected: false, evidence: [ev({ evidenceCategory: 'BOOKING_CTA_VISIBLE' })] });
    const res = computePatterns(buildInput([withBooking('a', 'A'), notSelected]));
    expect(patternFor(res, 'BOOKING_CTA_VISIBLE').totalSelected).toBe(1);
    expect(res.exclusions.some((e) => e.reason === 'NOT_SELECTED_CANDIDATE')).toBe(true);
  });

  it('UNSUPPORTED_INFERENCE evidence excluded → UNKNOWN', () => {
    const inf = comp({ competitorCandidateId: 'b', brandKey: 'B', capturedOk: true, evidence: [ev({ evidenceCategory: 'BOOKING_CTA_VISIBLE', observationKind: 'UNSUPPORTED_INFERENCE' })] });
    const res = computePatterns(buildInput([withBooking('a', 'A'), inf]));
    expect(patternFor(res, 'BOOKING_CTA_VISIBLE').unknownCount).toBe(1);
    expect(res.exclusions.some((e) => e.reason === 'UNSUPPORTED_INFERENCE')).toBe(true);
  });
});

describe('computePatterns — source traceability + wording', () => {
  it('a positive pattern carries exact evidence ids + source refs', () => {
    const res = computePatterns(buildInput([withBooking('a', 'A'), withBooking('b', 'B')]));
    const p = patternFor(res, 'BOOKING_CTA_VISIBLE');
    expect(p.evidenceItemIds.length).toBe(2);
    const refs = res.evidenceRefs.filter((r) => r.kind === 'COMPETITOR' && r.category === 'BOOKING_CTA_VISIBLE');
    expect(refs.length).toBe(2);
    expect(refs.every((r) => r.sourceUrl && r.sourceUrl.length > 0)).toBe(true);
    expect(p.wordingText).toBe('two nearby clinics');
  });
});

describe('computePatterns — prospect contrasts (explicit negatives only)', () => {
  it('boolean contrast when mapped positive pattern + EXPLICIT verified prospect negative', () => {
    const p = prospect([pref('tel')], { negatives: [{ category: 'BOOKING_CTA_VISIBLE', inspectionScope: 'mobile-initial-viewport', evidenceRef: 'prospect-neg-1' }] });
    const res = computePatterns(buildInput([withBooking('a', 'A'), withBooking('b', 'B')], p));
    const contrast = res.contrasts.find((c) => c.category === 'BOOKING_CTA_VISIBLE');
    expect(contrast).toBeDefined();
    expect(contrast?.prospectState).toBe('ABSENT');
  });

  it('a MISSING prospect primitive (no explicit negative) does NOT create a contrast', () => {
    // Prospect captured with only a phone link; no booking primitive AND no explicit negative → UNKNOWN.
    const res = computePatterns(buildInput([withBooking('a', 'A'), withBooking('b', 'B')], prospect([pref('tel')])));
    expect(res.contrasts.some((c) => c.category === 'BOOKING_CTA_VISIBLE')).toBe(false);
  });

  it('no contrast when prospect evidence PRESENT for the category', () => {
    const res = computePatterns(buildInput([withBooking('a', 'A'), withBooking('b', 'B')], prospect([pref('cta')])));
    expect(res.contrasts.some((c) => c.category === 'BOOKING_CTA_VISIBLE')).toBe(false);
  });

  it('no contrast when prospect capture is missing (missing != absence)', () => {
    const res = computePatterns(buildInput([withBooking('a', 'A'), withBooking('b', 'B')], noProspect()));
    expect(res.contrasts.length).toBe(0);
  });

  it('no contrast for an unmapped category even with an explicit prospect negative', () => {
    const hours = (id: string, brand: string) => comp({ competitorCandidateId: id, brandKey: brand, evidence: [ev({ evidenceCategory: 'OPENING_HOURS_VISIBLE' })] });
    const p = prospect([pref('tel')], { negatives: [{ category: 'OPENING_HOURS_VISIBLE', inspectionScope: 'homepage', evidenceRef: 'x' }] });
    const res = computePatterns(buildInput([hours('a', 'A'), hours('b', 'B')], p));
    expect(patternFor(res, 'OPENING_HOURS_VISIBLE').result).toBe('ALL_OBSERVED');
    expect(res.contrasts.some((c) => c.category === 'OPENING_HOURS_VISIBLE')).toBe(false);
  });
});

describe('depth categories', () => {
  it('median is computed for a depth category and never produces a contrast', () => {
    const d = (id: string, brand: string, v: number) => comp({ competitorCandidateId: id, brandKey: brand, evidence: [ev({ evidenceCategory: 'MOBILE_NAVIGATION_DEPTH', numericValue: v })] });
    const res = computePatterns(buildInput([d('a', 'A', 0), d('b', 'B', 1), d('c', 'C', 1)], prospect([pref('tel')])));
    const p = patternFor(res, 'MOBILE_NAVIGATION_DEPTH');
    expect(p.isDepth).toBe(true);
    expect(p.numericMedian).toBe(1);
    expect(p.numericValues.sort()).toEqual([0, 1, 1]);
    expect(res.contrasts.some((c) => c.category === 'MOBILE_NAVIGATION_DEPTH')).toBe(false);
  });

  it('median of even-length list averages the two middle values', () => {
    expect(median([0, 1, 1, 2])).toBe(1);
    expect(median([2, 4])).toBe(3);
    expect(median([])).toBeNull();
  });

  it('depthContrastAllowed requires >= 1 interaction deeper and >= 2 competitors', () => {
    expect(depthContrastAllowed(2, [0, 1, 1])).toBe(true); // median 1, prospect 2
    expect(depthContrastAllowed(1, [0, 1, 1])).toBe(false); // equal to median
    expect(depthContrastAllowed(3, [1])).toBe(false); // only one competitor
    expect(depthContrastAllowed(null, [0, 1])).toBe(false);
  });
});
