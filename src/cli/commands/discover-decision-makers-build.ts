import { assertLiveCallsAllowed } from '../../config/live-call-guard.js';
import { type DecisionMakerLlmDeps } from '../../domain/decision-makers/service.js';
import { MockLlmProvider, type MockResponder } from '../../integrations/llm/mock-llm.js';
import { OpenAiResponsesProvider } from '../../integrations/llm/openai-responses.js';
import { priceKnown, PRICE_VERIFIED_AT } from '../../integrations/llm/pricing.js';
import { type LlmProvider } from '../../integrations/llm/provider.js';
import { type CliContext } from '../context.js';

/** Mock responder for the default (non-openai) provider: proposes zero candidates — this stage never
 * fabricates a person, so the safe default output is empty, not a guess. */
const defaultMockResponder: MockResponder = () => ({
  rawJson: { candidates: [], insufficientEvidence: true },
});

/**
 * Build the decision-maker-extraction LLM provider + call config. Mirrors `audit-build.ts`'s exact gate
 * order: ALLOW_PAID_LLM_CALLS -> OPENAI_API_KEY -> LLM_MODEL_AUDIT set -> PRICE_VERIFIED_AT ->
 * priceKnown -> assertLiveCallsAllowed(DRY_RUN, label) -> construct; falls back to MockLlmProvider for
 * any other LLM_PROVIDER value. Reuses LLM_MODEL_AUDIT/LLM_REASONING_EFFORT_AUDIT — this task shares
 * the audit's model/cost tier, no dedicated model env var.
 */
export function buildDecisionMakerLlmDeps(ctx: CliContext): DecisionMakerLlmDeps {
  const c = ctx.config;
  let provider: LlmProvider;
  let model: string;
  if (c.LLM_PROVIDER === 'openai') {
    if (!c.ALLOW_PAID_LLM_CALLS) throw new Error('LLM_PROVIDER=openai requires ALLOW_PAID_LLM_CALLS=true (paid-call kill switch is off).');
    if (!c.OPENAI_API_KEY) throw new Error('LLM_PROVIDER=openai requires OPENAI_API_KEY.');
    if (!c.LLM_MODEL_AUDIT) throw new Error('LLM_PROVIDER=openai requires LLM_MODEL_AUDIT (e.g. gpt-5.6-sol).');
    if (!PRICE_VERIFIED_AT) throw new Error('LLM price table not yet verified (PRICE_VERIFIED_AT is null). Reconcile src/integrations/llm/pricing.ts with official pricing before any paid call.');
    if (!priceKnown(c.LLM_MODEL_AUDIT)) throw new Error(`No verified price for model "${c.LLM_MODEL_AUDIT}" — add it to pricing.ts before paid calls.`);
    // Global DRY_RUN kill switch: even with ALLOW_PAID_LLM_CALLS=true + key, dry-run blocks the live call.
    assertLiveCallsAllowed(c.DRY_RUN, 'decision-maker-extraction-llm');
    provider = new OpenAiResponsesProvider({ apiKey: c.OPENAI_API_KEY, logger: ctx.logger });
    model = c.LLM_MODEL_AUDIT;
  } else {
    provider = new MockLlmProvider(defaultMockResponder);
    model = c.LLM_MODEL_AUDIT ?? 'mock-decision-makers-1';
  }

  return {
    provider,
    model,
    reasoningEffort: c.LLM_REASONING_EFFORT_AUDIT,
    store: c.LLM_STORE_RESPONSES,
    timeoutMs: c.LLM_TIMEOUT_MS,
    maxOutputTokens: c.LLM_MAX_OUTPUT_TOKENS,
    maxRetries: c.LLM_MAX_RETRIES,
    maxCallsPerLead: c.MAX_LLM_CALLS_PER_LEAD,
    maxCostUsdPerLead: c.MAX_LLM_COST_USD_PER_LEAD,
    minConfidence: c.DECISION_MAKER_MIN_CONFIDENCE,
    logger: ctx.logger,
  };
}
