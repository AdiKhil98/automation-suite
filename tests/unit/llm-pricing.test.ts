import { describe, expect, it } from 'vitest';
import {
  contextTierFor,
  estimateCostUsd,
  priceKnown,
  PRICE_VERIFIED_AT,
  SHORT_CONTEXT_MAX_INPUT_TOKENS,
  worstCaseCostUsd,
} from '../../src/integrations/llm/pricing.js';
import { type LlmUsage } from '../../src/integrations/llm/provider.js';

const usage = (over: Partial<LlmUsage> = {}): LlmUsage => ({
  inputTokens: 10_000,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 1_000,
  reasoningTokens: 0,
  estimatedCostUsd: null,
  ...over,
});

describe('pricing (verified 2026-07-15)', () => {
  it('is marked verified', () => {
    expect(PRICE_VERIFIED_AT).toBe('2026-07-16');
  });

  it('knows only models with operator-verified prices', () => {
    expect(priceKnown('gpt-5.6-sol')).toBe(true);
    expect(priceKnown('gpt-5.6-terra')).toBe(true); // verified 2026-07-16 for Gate B
    expect(priceKnown('gpt-5.6-luna')).toBe(false); // still no verified price → blocked
    expect(priceKnown('anything-else')).toBe(false);
  });

  it('prices Terra at exactly half of Sol per token (short tier)', () => {
    const u = usage({ inputTokens: 10_000, outputTokens: 1_000 });
    const sol = estimateCostUsd('gpt-5.6-sol', u) as number;
    const terra = estimateCostUsd('gpt-5.6-terra', u) as number;
    expect(terra).toBeCloseTo(sol / 2, 9);
    // 10k in × $2.50 + 1k out × $15 per 1M
    expect(terra).toBeCloseTo(10_000 * 2.5e-6 + 1_000 * 15e-6, 9);
  });

  it('short-context: 10k in + 1k out at $5/$30 per 1M', () => {
    expect(estimateCostUsd('gpt-5.6-sol', usage())).toBeCloseTo(10_000 * 5e-6 + 1_000 * 30e-6, 9); // $0.08
  });

  it('long-context tier applies above the boundary at $10/$45 per 1M', () => {
    const u = usage({ inputTokens: SHORT_CONTEXT_MAX_INPUT_TOKENS + 1 });
    expect(contextTierFor(u)).toBe('long');
    expect(estimateCostUsd('gpt-5.6-sol', u)).toBeCloseTo((SHORT_CONTEXT_MAX_INPUT_TOKENS + 1) * 10e-6 + 1_000 * 45e-6, 6);
  });

  it('boundary token count itself is short-context', () => {
    expect(contextTierFor(usage({ inputTokens: SHORT_CONTEXT_MAX_INPUT_TOKENS }))).toBe('short');
  });

  it('cached input and cache writes are billed at their own rates', () => {
    const u = usage({ inputTokens: 10_000, cachedInputTokens: 4_000, cacheWriteTokens: 2_000 });
    // 6k uncached × $5 + 4k cached × $0.50 + 2k writes × $6.25 + 1k out × $30 (per 1M)
    expect(estimateCostUsd('gpt-5.6-sol', u)).toBeCloseTo(6_000 * 5e-6 + 4_000 * 0.5e-6 + 2_000 * 6.25e-6 + 1_000 * 30e-6, 9);
  });

  it('returns null (hard block) for unknown models', () => {
    expect(estimateCostUsd('gpt-5.6-luna', usage())).toBeNull(); // luna not yet verified
  });

  it('returns null (hard block) when the context tier is undeterminable', () => {
    expect(contextTierFor(usage({ inputTokens: null }))).toBeNull();
    expect(estimateCostUsd('gpt-5.6-sol', usage({ inputTokens: null }))).toBeNull();
  });

  it('worst-case bound uses the tier implied by the input ceiling, uncached', () => {
    expect(worstCaseCostUsd('gpt-5.6-sol', 40_000, 4_000)).toBeCloseTo(40_000 * 5e-6 + 4_000 * 30e-6, 9); // $0.32
    expect(worstCaseCostUsd('gpt-5.6-sol', 200_000, 4_000)).toBeCloseTo(200_000 * 10e-6 + 4_000 * 45e-6, 9); // long tier
    expect(worstCaseCostUsd('unknown', 1, 1)).toBeNull();
  });
});
