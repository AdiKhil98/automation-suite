import { describe, expect, it } from 'vitest';
import { ageInDays, evaluateFreshness } from '../../../src/domain/competitor/evidence-freshness.js';

const base = new Date('2026-01-01T00:00:00.000Z');
const plusDays = (n: number): Date => new Date(base.getTime() + n * 24 * 60 * 60 * 1000);

describe('evidence freshness (30-day window)', () => {
  it('computes whole-day age', () => {
    expect(ageInDays(base, plusDays(5))).toBe(5);
  });

  it('is FRESH strictly inside the window (day 29)', () => {
    expect(evaluateFreshness(base, plusDays(29), 30)).toBe('FRESH');
  });

  it('is STALE on the boundary (day 30) and beyond', () => {
    expect(evaluateFreshness(base, plusDays(30), 30)).toBe('STALE');
    expect(evaluateFreshness(base, plusDays(45), 30)).toBe('STALE');
  });

  it('treats an item aged past the window as stale even if stored FRESH (computed, not trusted)', () => {
    // Evidence captured at `base` reviewed 31 days later is stale regardless of any stored status.
    expect(evaluateFreshness(base, plusDays(31))).toBe('STALE');
  });
});
