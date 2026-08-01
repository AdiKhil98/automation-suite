import { describe, expect, it } from 'vitest';
import { computeConfigHash, computeInputHash } from '../../../src/domain/competitor/hash.js';
import { DEFAULT_SELECTION_CONFIG } from '../../../src/domain/competitor/selection.js';
import { candAtKm, prospect } from './helpers.js';

describe('competitor input/config hashing', () => {
  it('is stable regardless of candidate ordering', () => {
    const a = candAtKm(1, { rowIndex: 1, website: 'https://a.example' });
    const b = candAtKm(2, { rowIndex: 2, website: 'https://b.example' });
    expect(computeInputHash(prospect(), [a, b])).toBe(computeInputHash(prospect(), [b, a]));
  });

  it('changes when the candidate set materially changes', () => {
    const a = candAtKm(1, { rowIndex: 1, website: 'https://a.example' });
    const b = candAtKm(2, { rowIndex: 2, website: 'https://b.example' });
    expect(computeInputHash(prospect(), [a])).not.toBe(computeInputHash(prospect(), [a, b]));
  });

  it('changes when the prospect changes', () => {
    const a = candAtKm(1, { rowIndex: 1, website: 'https://a.example' });
    expect(computeInputHash(prospect(), [a])).not.toBe(computeInputHash(prospect({ primaryCategory: 'orthodontist' }), [a]));
  });

  it('config hash changes with configuration', () => {
    expect(computeConfigHash(DEFAULT_SELECTION_CONFIG)).not.toBe(
      computeConfigHash({ ...DEFAULT_SELECTION_CONFIG, maxSelected: 2 }),
    );
  });
});
