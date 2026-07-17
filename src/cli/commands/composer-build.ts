import { DemoComposerService } from '../../domain/demo/composer/demo-composer-service.js';
import { COMPOSER_TEMPLATE_ID, COMPOSER_TEMPLATE_VERSION } from '../../domain/demo/composer/compose.js';
import { worstCaseComposerInputTokens } from '../../domain/demo/composer/composer-token-budget.js';
import { defaultMockComposerResponder } from '../../fixtures/mock-composer-responses.js';
import { LocalComposerDebugStore } from '../../integrations/demo/composer-debug-store.js';
import { LocalDemoWriter } from '../../integrations/demo/demo-writer.js';
import { MockLlmProvider } from '../../integrations/llm/mock-llm.js';
import { OpenAiResponsesProvider } from '../../integrations/llm/openai-responses.js';
import { priceKnown, PRICE_VERIFIED_AT } from '../../integrations/llm/pricing.js';
import { type LlmProvider } from '../../integrations/llm/provider.js';
import { DrizzleComposerUnitOfWork } from '../../persistence/composer-unit-of-work.js';
import { type CliContext } from '../context.js';

export interface BuiltComposer {
  service: DemoComposerService;
  providerName: string;
}

/**
 * Build the AI Demo Composer service. Paid OpenAI calls are hard-gated exactly like the
 * audit service: LLM_PROVIDER=openai AND ALLOW_PAID_LLM_CALLS=true AND OPENAI_API_KEY AND a
 * verified price for both composer and reviewer models. Any missing piece throws here —
 * before any lead is touched and before any request could be made.
 */
export function buildComposerService(ctx: CliContext): BuiltComposer {
  const c = ctx.config;

  let provider: LlmProvider;
  if (c.LLM_PROVIDER === 'openai') {
    if (!c.ALLOW_PAID_LLM_CALLS) throw new Error('LLM_PROVIDER=openai requires ALLOW_PAID_LLM_CALLS=true (paid-call kill switch is off).');
    if (!c.OPENAI_API_KEY) throw new Error('LLM_PROVIDER=openai requires OPENAI_API_KEY.');
    if (!PRICE_VERIFIED_AT) throw new Error('LLM price table not yet verified (PRICE_VERIFIED_AT is null). Reconcile pricing.ts before any paid call.');
    if (!priceKnown(c.DEMO_COMPOSER_MODEL)) throw new Error(`No verified price for composer model "${c.DEMO_COMPOSER_MODEL}" — add it to pricing.ts before paid calls.`);
    if (!priceKnown(c.DEMO_COMPOSER_REVIEWER_MODEL)) throw new Error(`No verified price for reviewer model "${c.DEMO_COMPOSER_REVIEWER_MODEL}".`);
    provider = new OpenAiResponsesProvider({ apiKey: c.OPENAI_API_KEY, logger: ctx.logger });
  } else {
    provider = new MockLlmProvider(defaultMockComposerResponder);
  }

  const service = new DemoComposerService({
    provider,
    uow: new DrizzleComposerUnitOfWork(ctx.db),
    writer: new LocalDemoWriter(c.DEMO_OUTPUT_DIR),
    debug: new LocalComposerDebugStore(c.COMPOSER_DEBUG_DIR),
    logger: ctx.logger,
    config: {
      generatorModel: c.DEMO_COMPOSER_MODEL,
      reviewerModel: c.DEMO_COMPOSER_REVIEWER_MODEL,
      generatorEffort: c.DEMO_COMPOSER_EFFORT,
      reviewerEffort: c.DEMO_COMPOSER_REVIEWER_EFFORT,
      store: c.LLM_STORE_RESPONSES,
      timeoutMs: c.DEMO_COMPOSER_TIMEOUT_MS,
      maxOutputTokens: c.DEMO_COMPOSER_MAX_OUTPUT_TOKENS,
      maxRetries: c.DEMO_COMPOSER_MAX_RETRIES,
      maxCallsPerDemo: c.DEMO_COMPOSER_MAX_CALLS_PER_DEMO,
      maxCostUsdPerDemo: c.DEMO_COMPOSER_MAX_COST_USD_PER_DEMO,
      worstCaseInputTokensPerCall: worstCaseComposerInputTokens(),
      templateId: COMPOSER_TEMPLATE_ID,
      templateVersion: COMPOSER_TEMPLATE_VERSION,
    },
  });
  return { service, providerName: provider.name };
}
