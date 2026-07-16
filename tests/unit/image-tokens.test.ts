import { describe, expect, it } from 'vitest';
import {
  boundedDimensions,
  CONSERVATIVE_PATCH_MULTIPLIER,
  estimateImageTokens,
  MAX_UPLOAD_DIMENSION,
  PATCH_PX,
} from '../../src/integrations/llm/image-tokens.js';
import { worstCaseInputTokensForCall } from '../../src/domain/audit/token-budget.js';

describe('estimateImageTokens (GPT-5.6 patch-based, conservative)', () => {
  it('computes patches from actual dims and applies the conservative multiplier', () => {
    // 768x480 → ceil(768/32)=24 × ceil(480/32)=15 = 360 patches
    const est = estimateImageTokens(768, 480, 'high');
    expect(est).not.toBeNull();
    expect(est?.patches).toBe(24 * 15);
    expect(est?.tokens).toBe(Math.ceil(24 * 15 * CONSERVATIVE_PATCH_MULTIPLIER));
  });

  it('rounds patch counts up for non-multiples of the patch size', () => {
    // 390x844 → ceil(390/32)=13 × ceil(844/32)=27 = 351 patches
    const est = estimateImageTokens(390, 844, 'high');
    expect(est?.patches).toBe(Math.ceil(390 / PATCH_PX) * Math.ceil(844 / PATCH_PX));
  });

  it('returns null (block) for missing or zero dimensions', () => {
    expect(estimateImageTokens(null, 480, 'high')).toBeNull();
    expect(estimateImageTokens(768, null, 'high')).toBeNull();
    expect(estimateImageTokens(0, 480, 'high')).toBeNull();
    expect(estimateImageTokens(768, -1, 'high')).toBeNull();
  });

  it('returns null (block) for detail levels not priced for Gate A (auto/original)', () => {
    expect(estimateImageTokens(768, 480, 'auto')).toBeNull();
    expect(estimateImageTokens(768, 480, 'original')).toBeNull();
  });

  it('prices low detail as a small fixed conservative cost', () => {
    const est = estimateImageTokens(768, 480, 'low');
    expect(est?.tokens).toBe(Math.ceil(CONSERVATIVE_PATCH_MULTIPLIER * 85));
  });

  it('is deterministic', () => {
    expect(estimateImageTokens(1024, 768, 'high')).toEqual(estimateImageTokens(1024, 768, 'high'));
  });
});

describe('boundedDimensions', () => {
  it('caps the longest side at MAX_UPLOAD_DIMENSION, preserving aspect', () => {
    // desktop 1440x900 → longest 1440 → scale 768/1440 → 768x480
    expect(boundedDimensions(1440, 900)).toEqual({ width: 768, height: 480 });
  });

  it('caps a tall retina mobile screenshot (1170x2532 @DPR3) by height', () => {
    // longest 2532 → scale 768/2532 → width round(1170*768/2532)=355, height 768
    expect(boundedDimensions(1170, 2532)).toEqual({ width: 355, height: 768 });
  });

  it('leaves already-small images unchanged', () => {
    expect(boundedDimensions(400, 300)).toEqual({ width: 400, height: 300 });
  });

  it('keeps bounded images small enough to be cheap (< 1000 tokens each)', () => {
    for (const [w, h] of [[1440, 900], [1170, 2532], [390, 844]] as const) {
      const b = boundedDimensions(w, h, MAX_UPLOAD_DIMENSION);
      const est = estimateImageTokens(b.width, b.height, 'high');
      expect(est?.tokens).toBeLessThan(1000);
    }
  });
});

describe('worstCaseInputTokensForCall', () => {
  it('sums system + evidence + proposed findings + image tokens', () => {
    // 3000 + 40*160 + 12*700 + 1500 = 3000 + 6400 + 8400 + 1500 = 19300
    expect(worstCaseInputTokensForCall({ evidenceItems: 40, imageTokens: 1500 })).toBe(19300);
  });

  it('returns null when image tokens are undeterminable (blocks the call)', () => {
    expect(worstCaseInputTokensForCall({ evidenceItems: 40, imageTokens: null })).toBeNull();
  });
});
