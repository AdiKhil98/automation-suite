import { describe, expect, it } from 'vitest';
import { classifyCategoryMatch } from '../../../src/domain/competitor/category.js';

describe('classifyCategoryMatch', () => {
  it('returns EXACT for identical normalized categories', () => {
    expect(classifyCategoryMatch('Dentist', 'dentist')).toBe('EXACT');
  });
  it('returns RELATED only for explicitly grouped categories', () => {
    expect(classifyCategoryMatch('dentist', 'orthodontist')).toBe('RELATED');
    expect(classifyCategoryMatch('dentist', 'dental clinic')).toBe('RELATED');
  });
  it('returns WEAK for known-but-unrelated categories (unknown relationship is never related)', () => {
    expect(classifyCategoryMatch('dentist', 'restaurant')).toBe('WEAK');
    expect(classifyCategoryMatch('dentist', 'plumber')).toBe('WEAK');
  });
  it('returns NONE when the candidate has no category', () => {
    expect(classifyCategoryMatch('dentist', null)).toBe('NONE');
    expect(classifyCategoryMatch('dentist', '')).toBe('NONE');
  });
  it('returns WEAK when the prospect category is unknown but candidate has one', () => {
    expect(classifyCategoryMatch(null, 'dentist')).toBe('WEAK');
  });
});
