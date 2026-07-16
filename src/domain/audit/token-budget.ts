/**
 * Conservative upper bounds on the input tokens a single audit call can carry, derived
 * ONLY from the configured limits (evidence items, images). Used for a pre-call
 * worst-case cost projection so the per-lead cost cap is a *structural* guarantee — a
 * call is refused unless its worst-case completion still fits the budget — rather than
 * an after-the-fact overshoot. All constants are deliberate over-estimates; real calls
 * carry far fewer tokens.
 */
export const TOKEN_BUDGET = {
  // System prompt + rubric + category defs + safety + strict JSON schema. Measured at
  // ~1.1k tokens; rounded up hard.
  systemAndSchemaTokens: 3_000,
  // One serialized evidence line: value sliced to 300 chars + URL + metadata (~640
  // chars) ÷ 4 chars/token, rounded up.
  perEvidenceItemTokens: 160,
  // Reviewer input also echoes proposed findings (≤12 by schema), each with
  // observation/impact/recommendation up to 600 chars = ~1.8k chars ≈ 450 tokens;
  // rounded to 700 for outreach angle + scaffolding.
  perProposedFindingTokens: 700,
  maxProposedFindings: 12,
  // Primary viewport screenshot at detail:'high'. Bounded well above GPT-5.6 tiling for
  // 1440×900 / 390×844 viewports.
  perHighDetailImageTokens: 2_600,
} as const;

export function worstCaseInputTokens(opts: { maxEvidenceItems: number; maxImages: number }): number {
  return (
    TOKEN_BUDGET.systemAndSchemaTokens +
    opts.maxEvidenceItems * TOKEN_BUDGET.perEvidenceItemTokens +
    TOKEN_BUDGET.maxProposedFindings * TOKEN_BUDGET.perProposedFindingTokens +
    opts.maxImages * TOKEN_BUDGET.perHighDetailImageTokens
  );
}

/**
 * Per-lead worst-case input tokens for a single call, using the ACTUAL vision-token
 * estimate of each (already bounded) image rather than a flat per-image constant.
 * Returns null when any image's tokens cannot be determined — the caller must block
 * the paid call. `imageTokens` is the sum of estimateImageTokens(...).tokens for the
 * package's images, or null if any was null.
 */
export function worstCaseInputTokensForCall(opts: {
  evidenceItems: number;
  imageTokens: number | null;
}): number | null {
  if (opts.imageTokens === null) return null;
  return (
    TOKEN_BUDGET.systemAndSchemaTokens +
    opts.evidenceItems * TOKEN_BUDGET.perEvidenceItemTokens +
    TOKEN_BUDGET.maxProposedFindings * TOKEN_BUDGET.perProposedFindingTokens +
    opts.imageTokens
  );
}
