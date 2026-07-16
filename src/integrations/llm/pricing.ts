import { type LlmUsage } from './provider.js';

export const PRICE_TABLE_VERSION = 'llm-prices-3';
// Reconciled with the official OpenAI API pricing page. Sol verified 2026-07-15;
// Terra added + both re-verified 2026-07-16 (for the Gate B eval matrix).
export const PRICE_VERIFIED_AT: string | null = '2026-07-16';
export const PRICE_SOURCE = 'https://developers.openai.com/api/docs/pricing (official OpenAI API pricing, verified 2026-07-16)';

/**
 * Context-tier boundary — INTERNAL CONSERVATIVE CLASSIFICATION, **not an official
 * published OpenAI threshold**. Verified 2026-07-15: the official pricing page shows
 * separate "Short context"/"Long context" columns for gpt-5.6-* but does NOT publish
 * the token boundary between them. We classify inputs ≤128k as short. This is safe for
 * our use because audit inputs are hard-bounded far below it (evidence/image caps keep
 * worst-case input <40k tokens); any input above this constant is billed at the long
 * (higher) tier — an over-estimate, never an under-estimate. Update this only when an
 * official boundary is documented, and record it as official then.
 */
export const SHORT_CONTEXT_MAX_INPUT_TOKENS = 128_000;
export const SHORT_CONTEXT_THRESHOLD_IS_OFFICIAL = false;

export type ContextTier = 'short' | 'long';

/** USD per 1,000,000 tokens for one context tier. */
interface TierPrices {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
}

interface PriceRow {
  short: TierPrices;
  long: TierPrices;
}

/**
 * Verified prices only — a model absent here blocks paid calls entirely (no guessed
 * prices). gpt-5.6-sol Standard processing, per 1M tokens, verified 2026-07-15.
 */
const PRICES: Record<string, PriceRow> = {
  'gpt-5.6-sol': {
    short: { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 30 },
    long: { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 45 },
  },
  'gpt-5.6-terra': {
    short: { input: 2.5, cachedInput: 0.25, cacheWrite: 3.125, output: 15 },
    long: { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 22.5 },
  },
};

export function priceKnown(model: string): boolean {
  return model in PRICES;
}

/**
 * Determine the billing tier from reported usage. Returns null when the tier cannot
 * be determined (missing input-token count) — callers must treat null as a hard block
 * on further paid calls, never as zero cost.
 */
export function contextTierFor(usage: LlmUsage): ContextTier | null {
  if (usage.inputTokens === null) return null;
  return usage.inputTokens <= SHORT_CONTEXT_MAX_INPUT_TOKENS ? 'short' : 'long';
}

/**
 * Estimate cost in USD from reported usage. Returns null when the model has no
 * verified price OR the context tier cannot be determined; null means "unaccountable
 * spend" and blocks further paid calls upstream.
 */
export function estimateCostUsd(model: string, usage: LlmUsage): number | null {
  const row = PRICES[model];
  if (!row) return null;
  const tier = contextTierFor(usage);
  if (tier === null) return null;
  const p = row[tier];
  const uncached = (usage.inputTokens ?? 0) - (usage.cachedInputTokens ?? 0);
  const cost =
    (Math.max(0, uncached) / 1_000_000) * p.input +
    ((usage.cachedInputTokens ?? 0) / 1_000_000) * p.cachedInput +
    ((usage.cacheWriteTokens ?? 0) / 1_000_000) * p.cacheWrite +
    ((usage.outputTokens ?? 0) / 1_000_000) * p.output;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/** Worst-case (upper-bound) cost for a planned call, used for pre-call budget proofs. */
export function worstCaseCostUsd(
  model: string,
  maxInputTokens: number,
  maxOutputTokens: number,
): number | null {
  const row = PRICES[model];
  if (!row) return null;
  const tier: ContextTier = maxInputTokens <= SHORT_CONTEXT_MAX_INPUT_TOKENS ? 'short' : 'long';
  const p = row[tier];
  // No caching assumed (cache writes cost more than plain input; Gate A runs uncached).
  return (maxInputTokens / 1_000_000) * p.input + (maxOutputTokens / 1_000_000) * p.output;
}
