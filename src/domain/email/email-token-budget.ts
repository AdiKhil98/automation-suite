/**
 * Conservative upper bound on the input tokens a single email call (writer OR reviewer)
 * can carry. Text-only, fully determined by configured limits. Used for a pre-call
 * worst-case cost projection so the per-lead cost cap is a structural guarantee. Every
 * constant is a deliberate over-estimate.
 */
export const EMAIL_TOKEN_BUDGET = {
  systemAndSchemaTokens: 3_000,
  perFindingTokens: 400,
  maxFindings: 5,
  factsAndDemoTokens: 500,
  // The reviewer also echoes the drafted email (subject + ≤3 paragraphs + selections).
  draftedEmailTokens: 900,
} as const;

export function worstCaseEmailInputTokens(): number {
  return (
    EMAIL_TOKEN_BUDGET.systemAndSchemaTokens +
    EMAIL_TOKEN_BUDGET.maxFindings * EMAIL_TOKEN_BUDGET.perFindingTokens +
    EMAIL_TOKEN_BUDGET.factsAndDemoTokens +
    EMAIL_TOKEN_BUDGET.draftedEmailTokens
  );
}
