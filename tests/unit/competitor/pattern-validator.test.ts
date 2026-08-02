import { describe, expect, it } from 'vitest';
import { isApprovableConfidence, validatePackage } from '../../../src/domain/competitor/pattern-validator.js';
import { type CompetitorPattern, type CompetitorPatternPackage } from '../../../src/domain/competitor/pattern-types.js';

function positivePattern(overrides: Partial<CompetitorPattern> = {}): CompetitorPattern {
  return {
    category: 'BOOKING_CTA_VISIBLE',
    result: 'ALL_OBSERVED',
    presentCount: 2,
    absentCount: 0,
    unknownCount: 0,
    usableDenominator: 2,
    totalSelected: 2,
    participatingCompetitorIds: ['a', 'b'],
    evidenceItemIds: ['e1', 'e2'],
    confidence: 'MEDIUM',
    wordingForm: 'TWO_OF_TWO',
    wordingText: 'two nearby clinics',
    consequenceLabel: 'BOOKING_DISCOVERABILITY',
    numericMedian: null,
    numericValues: [],
    isDepth: false,
    ...overrides,
  };
}

function pkg(patterns: CompetitorPattern[], overrides: Partial<CompetitorPatternPackage> = {}): CompetitorPatternPackage {
  return {
    leadId: 'lead-1',
    researchRunId: 'r-1',
    captureRunIds: ['cap-1'],
    selectedCompetitorIds: ['a', 'b'],
    eligibleEvidenceCount: 2,
    excludedEvidenceCount: 0,
    exclusions: [],
    patterns,
    contrasts: [],
    evidenceRefs: [
      { kind: 'COMPETITOR', evidenceItemId: 'e1', captureRunId: 'cap-1', competitorCandidateId: 'a', category: 'BOOKING_CTA_VISIBLE', sourceUrl: 'https://a.example/' },
      { kind: 'COMPETITOR', evidenceItemId: 'e2', captureRunId: 'cap-1', competitorCandidateId: 'b', category: 'BOOKING_CTA_VISIBLE', sourceUrl: 'https://b.example/' },
    ],
    confidence: 'MEDIUM',
    freshnessEvaluatedAt: new Date('2026-02-01T00:00:00Z'),
    rulesVersion: 'test',
    inputHash: 'ih',
    configHash: 'ch',
    packageHash: 'ph',
    prohibitedClaims: [],
    status: 'DRAFT',
    ...overrides,
  };
}

describe('pattern validator', () => {
  it('accepts a clean, source-traceable, anonymized package', () => {
    expect(validatePackage(pkg([positivePattern()]), [null]).ok).toBe(true);
  });

  it('FAILS on a performance/conversion claim in wording', () => {
    const res = validatePackage(pkg([positivePattern({ wordingText: 'these competitors convert better' })]), [null]);
    expect(res.ok).toBe(false);
    expect(res.prohibitedClaims.length).toBeGreaterThan(0);
  });

  it('FAILS on revenue and ranking claims', () => {
    expect(validatePackage(pkg([positivePattern({ wordingText: 'this costs revenue' })]), [null]).ok).toBe(false);
    expect(validatePackage(pkg([positivePattern({ wordingText: 'they rank higher' })]), [null]).ok).toBe(false);
  });

  it('FAILS when a competitor name leaks into anonymized wording', () => {
    const res = validatePackage(pkg([positivePattern({ wordingText: 'compared to Zahnarztpraxis clinics' })]), ['Zahnarztpraxis Berlin']);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.toLowerCase().includes('leaked'))).toBe(true);
  });

  it('FAILS when wording form is inconsistent with counts', () => {
    const res = validatePackage(pkg([positivePattern({ wordingForm: 'ALL_OF_THREE' })]), [null]);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes('inconsistent with counts'))).toBe(true);
  });

  it('FAILS when a positive pattern has no source evidence', () => {
    const res = validatePackage(pkg([positivePattern({ evidenceItemIds: [] })]), [null]);
    expect(res.ok).toBe(false);
  });

  it('FAILS when a positive pattern denominator < 2 (sample of one)', () => {
    const res = validatePackage(pkg([positivePattern({ result: 'MAJORITY_OBSERVED', presentCount: 1, usableDenominator: 1, wordingForm: 'NONE', wordingText: null })]), [null]);
    expect(res.ok).toBe(false);
  });

  it('FAILS a LOW-confidence positive pattern (not approvable)', () => {
    const res = validatePackage(pkg([positivePattern({ confidence: 'LOW' })]), [null]);
    expect(res.ok).toBe(false);
  });

  it('FAILS when a competitor evidence ref is missing a source URL', () => {
    const p = pkg([positivePattern()], {
      evidenceRefs: [{ kind: 'COMPETITOR', evidenceItemId: 'e1', captureRunId: 'cap-1', competitorCandidateId: 'a', category: 'BOOKING_CTA_VISIBLE', sourceUrl: null }],
    });
    expect(validatePackage(p, [null]).ok).toBe(false);
  });

  it('isApprovableConfidence allows only HIGH/MEDIUM', () => {
    expect(isApprovableConfidence('HIGH')).toBe(true);
    expect(isApprovableConfidence('MEDIUM')).toBe(true);
    expect(isApprovableConfidence('LOW')).toBe(false);
  });
});
