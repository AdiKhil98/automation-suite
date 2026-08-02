import { describe, expect, it } from 'vitest';
import { wordingFormFor, wordingTextFor } from '../../../src/domain/competitor/pattern-wording.js';

describe('pattern wording — anonymized, count-bound', () => {
  it('maps exact counts to the correct form', () => {
    expect(wordingFormFor(2, 2)).toBe('TWO_OF_TWO');
    expect(wordingFormFor(2, 3)).toBe('TWO_OF_THREE');
    expect(wordingFormFor(3, 3)).toBe('ALL_OF_THREE');
    expect(wordingFormFor(1, 2)).toBe('NONE');
    expect(wordingFormFor(1, 1)).toBe('NONE');
  });

  it('produces anonymized text with no competitor names or superlatives', () => {
    expect(wordingTextFor('TWO_OF_TWO')).toBe('two nearby clinics');
    expect(wordingTextFor('TWO_OF_THREE')).toBe('two of three comparable nearby clinics');
    expect(wordingTextFor('ALL_OF_THREE')).toBe('all three comparable nearby clinics');
    expect(wordingTextFor('NONE')).toBeNull();
  });

  it('never emits banned market/leader wording', () => {
    const all = (['TWO_OF_TWO', 'TWO_OF_THREE', 'ALL_OF_THREE'] as const).map((f) => wordingTextFor(f) ?? '');
    for (const text of all) {
      expect(text).not.toMatch(/market|leader|best|top|most successful|everyone|all competitors/i);
    }
  });
});
