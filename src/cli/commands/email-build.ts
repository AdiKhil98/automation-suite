import { EmailWriterService } from '../../domain/email/email-writer-service.js';
import {
  type EmailProviderConfigView,
  requireLiveEmailProviderConfig,
} from '../../domain/email/llm-provider-policy.js';
import { worstCaseEmailInputTokens } from '../../domain/email/email-token-budget.js';
import { defaultMockEmailResponder } from '../../fixtures/mock-email-responses.js';
import { LocalEmailDebugStore } from '../../integrations/email/email-debug-store.js';
import { MockLlmProvider } from '../../integrations/llm/mock-llm.js';
import { OpenAiResponsesProvider } from '../../integrations/llm/openai-responses.js';
import { type LlmProvider } from '../../integrations/llm/provider.js';
import { DrizzleEmailUnitOfWork } from '../../persistence/email-unit-of-work.js';
import { type CliContext } from '../context.js';

export interface BuiltEmail {
  service: EmailWriterService;
  providerName: string;
}

/** Build the email LLM provider with the same paid-call hard gates the writer/audit services use.
 * Mock is the default; OpenAI requires every paid-call precondition. No call is made here. */
export function buildEmailProvider(ctx: CliContext): LlmProvider {
  const c = ctx.config;
  if (c.LLM_PROVIDER === 'openai') {
    // Identical preconditions to the eager preflight in `run-followup-automation`, from one place.
    const { apiKey } = requireLiveEmailProviderConfig(emailProviderConfigView(c));
    return new OpenAiResponsesProvider({ apiKey, logger: ctx.logger });
  }
  return new MockLlmProvider(defaultMockEmailResponder);
}

/** The provider-selection slice of config, for the pure policies in the email domain. */
export function emailProviderConfigView(c: CliContext['config']): EmailProviderConfigView {
  return {
    llmProvider: c.LLM_PROVIDER,
    allowPaidLlmCalls: c.ALLOW_PAID_LLM_CALLS,
    openAiApiKey: c.OPENAI_API_KEY,
    writerModel: c.EMAIL_WRITER_MODEL,
    reviewerModel: c.EMAIL_REVIEWER_MODEL,
  };
}

/** Build the email writer service. Paid OpenAI calls are hard-gated exactly like the audit
 * and composer services. Any missing piece throws before any lead is touched. */
export function buildEmailService(ctx: CliContext): BuiltEmail {
  const c = ctx.config;
  const provider: LlmProvider = buildEmailProvider(ctx);

  const service = new EmailWriterService({
    provider,
    uow: new DrizzleEmailUnitOfWork(ctx.db),
    debug: new LocalEmailDebugStore(c.EMAIL_DEBUG_DIR),
    logger: ctx.logger,
    config: {
      writerModel: c.EMAIL_WRITER_MODEL, reviewerModel: c.EMAIL_REVIEWER_MODEL,
      writerEffort: c.EMAIL_WRITER_EFFORT, reviewerEffort: c.EMAIL_REVIEWER_EFFORT,
      store: c.LLM_STORE_RESPONSES, timeoutMs: c.EMAIL_TIMEOUT_MS, maxOutputTokens: c.EMAIL_MAX_OUTPUT_TOKENS,
      maxRetries: c.EMAIL_MAX_RETRIES, maxCallsPerLead: c.EMAIL_MAX_CALLS_PER_LEAD, maxCostUsdPerLead: c.EMAIL_MAX_COST_USD_PER_LEAD,
      worstCaseInputTokensPerCall: worstCaseEmailInputTokens(),
    },
  });
  return { service, providerName: provider.name };
}
