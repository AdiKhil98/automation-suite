/**
 * LOCAL price table for estimating Places API cost (assumption A-0007). These are
 * placeholder estimates in USD per 1,000 requests and MUST be reconciled against
 * the official Google Maps Platform pricing for the account's region before any
 * cost figure is treated as authoritative. Field masking selects the tier; Phase 2
 * discovery uses the IDs-only 'Essentials' tier.
 */
export type BilledTier = 'Essentials' | 'Pro' | 'Enterprise';

const PRICE_PER_1000_USD: Record<BilledTier, number> = {
  Essentials: 5,
  Pro: 32,
  Enterprise: 35,
};

export function estimateCostUsd(tier: BilledTier, requestCount: number): number {
  return (requestCount / 1000) * PRICE_PER_1000_USD[tier];
}
