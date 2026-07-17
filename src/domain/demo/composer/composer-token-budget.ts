/**
 * Conservative upper bound on the input tokens a single composer call (generator OR
 * reviewer) can carry. The composer is TEXT-ONLY (no screenshots), so the bound is small
 * and fully determined by the configured limits. Used for a pre-call worst-case cost
 * projection so the per-demo cost cap is a structural guarantee, not a post-hoc overshoot.
 * Every constant is a deliberate over-estimate; real calls carry far fewer tokens.
 */
export const COMPOSER_TOKEN_BUDGET = {
  // Generator/reviewer system prompt + component catalog + allow-lists + strict JSON schema.
  // Measured at ~1.6k tokens; rounded up hard.
  systemAndSchemaTokens: 3_500,
  // One accepted finding echoed into the brief: observation + recommendation up to ~1.2k
  // chars ÷ 4 chars/token, rounded up.
  perFindingTokens: 400,
  // Accepted findings are capped upstream (MAX_FINDINGS = 5).
  maxFindings: 5,
  // Verified-facts block (name/city/services/available keys/achievable intents).
  factsTokens: 600,
  // The reviewer also echoes the proposed spec JSON (≤6 sections). Bounded well above its size.
  proposedSpecTokens: 1_400,
} as const;

export function worstCaseComposerInputTokens(): number {
  return (
    COMPOSER_TOKEN_BUDGET.systemAndSchemaTokens +
    COMPOSER_TOKEN_BUDGET.maxFindings * COMPOSER_TOKEN_BUDGET.perFindingTokens +
    COMPOSER_TOKEN_BUDGET.factsTokens +
    COMPOSER_TOKEN_BUDGET.proposedSpecTokens
  );
}
