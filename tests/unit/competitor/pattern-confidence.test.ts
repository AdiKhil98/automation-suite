import { describe, expect, it } from 'vitest';
import { lowerConfidence, patternConfidence } from '../../../src/domain/competitor/pattern-confidence.js';

describe('pattern confidence', () => {
  it('HIGH requires denominator 3, all HIGH, >= 2 present', () => {
    expect(patternConfidence(3, 2, ['HIGH', 'HIGH'], true)).toBe('HIGH');
    expect(patternConfidence(3, 3, ['HIGH', 'HIGH', 'HIGH'], true)).toBe('HIGH');
  });

  it('MEDIUM when denominator >= 2 with HIGH|MEDIUM evidence (denominator 2 can never be HIGH)', () => {
    expect(patternConfidence(2, 2, ['HIGH', 'HIGH'], true)).toBe('MEDIUM');
    expect(patternConfidence(3, 2, ['HIGH', 'MEDIUM'], true)).toBe('MEDIUM');
  });

  it('LOW when there is no participating evidence or freshness fails', () => {
    expect(patternConfidence(3, 2, [], true)).toBe('LOW');
    expect(patternConfidence(3, 2, ['HIGH', 'HIGH'], false)).toBe('LOW');
  });

  it('lowerConfidence returns the weaker band (contrast bounding)', () => {
    expect(lowerConfidence('HIGH', 'MEDIUM')).toBe('MEDIUM');
    expect(lowerConfidence('MEDIUM', 'HIGH')).toBe('MEDIUM');
    expect(lowerConfidence('HIGH', 'HIGH')).toBe('HIGH');
    expect(lowerConfidence('LOW', 'HIGH')).toBe('LOW');
  });
});
