import { priceKnown, worstCaseCostUsd } from '../../../integrations/llm/pricing.js';
import { boundedDimensions, estimateImageTokens } from '../../../integrations/llm/image-tokens.js';
import { type ImageDetail } from '../../../integrations/llm/provider.js';
import {
  visualReviewInputFingerprint, type VisualReviewInput,
} from './visual-review-input.js';
import { type VisualReviewResult } from './visual-review.js';

/**
 * Pre-call cost enforcement for the live visual reviewer.
 *
 * Before any live call the caller MUST project the worst-case cost of that call, add the prior
 * Demo V2 spend already recorded for the artifact, and reject the call when the projected total
 * would exceed `DEMO_V2_MAX_COST_USD_PER_DEMO` (default $3.00). An unknown price or an
 * undeterminable projection blocks the call — it is never treated as free.
 */

/** Conservative characters-per-token divisor for the serialized text input (over-estimates). */
const CHARS_PER_TOKEN = 3;

export interface VisualReviewCostProjection {
  worstCaseInputTokens: number;
  worstCaseOutputTokens: number;
  /** null ⇒ unaccountable (unknown price or undeterminable image tokens): the call must be blocked. */
  projectedUsd: number | null;
}

export interface VisualReviewCostProjectionRequest {
  model: string;
  input: VisualReviewInput;
  maxOutputTokens: number;
  imageDetail: ImageDetail;
  /** ACTUAL screenshot pixel dimensions that will be uploaded (baseline + final). */
  screenshotDimensions: ReadonlyArray<{ width: number; height: number }>;
}

/** Worst-case (upper-bound) projected cost for one live reviewer call. */
export function projectVisualReviewCost(req: VisualReviewCostProjectionRequest): VisualReviewCostProjection {
  const textTokens = Math.ceil(JSON.stringify(req.input).length / CHARS_PER_TOKEN);

  let imageTokens = 0;
  let imageAccountable = true;
  for (const dimension of req.screenshotDimensions) {
    const bounded = boundedDimensions(dimension.width, dimension.height);
    const estimate = estimateImageTokens(bounded.width, bounded.height, req.imageDetail);
    if (estimate === null) { imageAccountable = false; break; }
    imageTokens += estimate.tokens;
  }

  const worstCaseInputTokens = textTokens + imageTokens;
  const worstCaseOutputTokens = req.maxOutputTokens;

  if (!imageAccountable || !priceKnown(req.model)) {
    return { worstCaseInputTokens, worstCaseOutputTokens, projectedUsd: null };
  }
  const projectedUsd = worstCaseCostUsd(req.model, worstCaseInputTokens, worstCaseOutputTokens);
  return { worstCaseInputTokens, worstCaseOutputTokens, projectedUsd };
}

export interface DemoV2BudgetDecision {
  allowed: boolean;
  reason: string | null;
  projectedUsd: number | null;
  priorSpendUsd: number;
  ceilingUsd: number;
  projectedTotalUsd: number | null;
}

/** Pure budget check: prior spend + this call's worst case must not exceed the ceiling. */
export function evaluateDemoV2Budget(input: {
  projection: VisualReviewCostProjection;
  priorSpendUsd: number;
  ceilingUsd: number;
}): DemoV2BudgetDecision {
  const { projection, priorSpendUsd, ceilingUsd } = input;
  const base = { projectedUsd: projection.projectedUsd, priorSpendUsd, ceilingUsd };
  if (projection.projectedUsd === null) {
    return { allowed: false, reason: 'cost_unaccountable', projectedTotalUsd: null, ...base };
  }
  const projectedTotalUsd = Math.round((priorSpendUsd + projection.projectedUsd) * 1_000_000) / 1_000_000;
  if (projectedTotalUsd > ceilingUsd) {
    return { allowed: false, reason: 'budget_ceiling_exceeded', projectedTotalUsd, ...base };
  }
  return { allowed: true, reason: null, projectedTotalUsd, ...base };
}

/** Throw a fail-closed error when the budget check refuses the call. */
export function assertWithinDemoV2Budget(decision: DemoV2BudgetDecision): void {
  if (!decision.allowed) {
    throw new Error(`demo_v2_visual_review_budget_blocked:${decision.reason ?? 'unknown'}`);
  }
}

/**
 * Exact-fingerprint reviewer cache. A repeated review of a byte-identical input never triggers a
 * second (paid) call — it returns the cached verdict. The key is the deterministic input
 * fingerprint, so any change to render, screenshots, brief, plan, or evidence is a cache miss.
 */
export class VisualReviewCache {
  private readonly entries = new Map<string, VisualReviewResult>();

  get(fingerprint: string): VisualReviewResult | null {
    return this.entries.get(fingerprint) ?? null;
  }

  getForInput(input: VisualReviewInput): VisualReviewResult | null {
    return this.get(visualReviewInputFingerprint(input));
  }

  set(fingerprint: string, result: VisualReviewResult): void {
    this.entries.set(fingerprint, result);
  }

  has(fingerprint: string): boolean {
    return this.entries.has(fingerprint);
  }
}
