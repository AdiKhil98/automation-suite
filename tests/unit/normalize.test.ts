import { describe, expect, it } from 'vitest';
import {
  normalizeAddress,
  normalizeDomain,
  normalizeName,
  normalizePhone,
} from '../../src/domain/leads/normalize.js';
import { haversineMeters } from '../../src/utils/geo.js';

describe('normalizeDomain', () => {
  it('collapses URL variants to the same host', () => {
    const expected = 'brightsmiledental.example';
    expect(normalizeDomain('https://www.brightsmiledental.example')).toBe(expected);
    expect(normalizeDomain('http://brightsmiledental.example/')).toBe(expected);
    expect(normalizeDomain('BrightSmileDental.Example/contact')).toBe(expected);
    expect(normalizeDomain('www.brightsmiledental.example')).toBe(expected);
  });
  it('returns null for empty/nullish', () => {
    expect(normalizeDomain(null)).toBeNull();
    expect(normalizeDomain('   ')).toBeNull();
  });
});

describe('normalizePhone', () => {
  it('treats formatting and national/international trunk as equal', () => {
    const nsn = '1614960000';
    expect(normalizePhone('+44 161 496 0000')).toBe(nsn);
    expect(normalizePhone('0161 496 0000')).toBe(nsn);
    expect(normalizePhone('(0161) 496-0000')).toBe(nsn);
    expect(normalizePhone('0044 161 496 0000')).toBe(nsn);
  });
  it('returns null when there are no digits', () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone('n/a')).toBeNull();
  });
});

describe('normalizeName / normalizeAddress', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeName('  Bright   Smile  ')).toBe('bright smile');
    expect(normalizeAddress('12 Oxford Road, Manchester, M1 5QA')).toBe(
      '12 oxford road manchester m1 5qa',
    );
  });
});

describe('haversineMeters', () => {
  it('is ~0 for identical points and grows with distance', () => {
    expect(haversineMeters(53.4739, -2.2352, 53.4739, -2.2352)).toBeCloseTo(0, 5);
    // ~0.001 deg latitude ≈ 111 m
    expect(haversineMeters(53.4739, -2.2352, 53.4749, -2.2352)).toBeGreaterThan(100);
  });
});
