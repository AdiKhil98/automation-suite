import { AuditService } from '../../domain/audit/audit-service.js';
import { worstCaseInputTokens } from '../../domain/audit/token-budget.js';
import { defaultMockAuditResponder } from '../../fixtures/mock-audit-responses.js';
import { LocalAuditDebugStore } from '../../integrations/audit/debug-store.js';
import { LocalEnvelopeStore } from '../../integrations/audit/envelope-store.js';
import { MockLlmProvider } from '../../integrations/llm/mock-llm.js';
import { OpenAiResponsesProvider } from '../../integrations/llm/openai-responses.js';
import { priceKnown, PRICE_VERIFIED_AT } from '../../integrations/llm/pricing.js';
import { type LlmProvider } from '../../integrations/llm/provider.js';
import { DrizzleAuditUnitOfWork } from '../../persistence/audit-unit-of-work.js';
import { type CliContext } from '../context.js';

export interface BuiltAudit {
  service: AuditService;
  envelopes: LocalEnvelopeStore;
  uow: DrizzleAuditUnitOfWork;
  debug: LocalAuditDebugStore;
  providerName: string;
}

/**
 * Build the audit service. Paid OpenAI calls are hard-gated: they require
 * LLM_PROVIDER=openai AND ALLOW_PAID_LLM_CALLS=true AND OPENAI_API_KEY AND
 * LLM_MODEL_AUDIT with a verified price. Any missing piece throws here — before
 * any lead is touched and before any request could be made.
 */
export function buildAuditService(ctx: CliContext, opts?: { severeCaptureLimitations?: boolean }): BuiltAudit {
  const c = ctx.config;

  let provider: LlmProvider;
  let auditModel: string;
  if (c.LLM_PROVIDER === 'openai') {
    if (!c.ALLOW_PAID_LLM_CALLS) throw new Error('LLM_PROVIDER=openai requires ALLOW_PAID_LLM_CALLS=true (paid-call kill switch is off).');
    if (!c.OPENAI_API_KEY) throw new Error('LLM_PROVIDER=openai requires OPENAI_API_KEY.');
    if (!c.LLM_MODEL_AUDIT) throw new Error('LLM_PROVIDER=openai requires LLM_MODEL_AUDIT (e.g. gpt-5.6-sol).');
    if (!PRICE_VERIFIED_AT) throw new Error('LLM price table not yet verified (PRICE_VERIFIED_AT is null). Reconcile src/integrations/llm/pricing.ts with official pricing before any paid call (Gate A prerequisite).');
    if (!priceKnown(c.LLM_MODEL_AUDIT)) throw new Error(`No verified price for model "${c.LLM_MODEL_AUDIT}" — add it to pricing.ts before paid calls.`);
    const reviewModel = c.LLM_MODEL_REVIEW ?? c.LLM_MODEL_AUDIT;
    if (!priceKnown(reviewModel)) throw new Error(`No verified price for review model "${reviewModel}".`);
    provider = new OpenAiResponsesProvider({ apiKey: c.OPENAI_API_KEY, logger: ctx.logger });
    auditModel = c.LLM_MODEL_AUDIT;
  } else {
    provider = new MockLlmProvider(defaultMockAuditResponder);
    auditModel = c.LLM_MODEL_AUDIT ?? 'mock-audit-1';
  }

  const uow = new DrizzleAuditUnitOfWork(ctx.db);
  const envelopes = new LocalEnvelopeStore(c.AUDIT_ENVELOPE_DIR);
  const debug = new LocalAuditDebugStore(c.AUDIT_DEBUG_DIR);
  const service = new AuditService({
    provider,
    uow,
    envelopes,
    debug,
    logger: ctx.logger,
    config: {
      auditModel,
      reviewModel: c.LLM_MODEL_REVIEW ?? auditModel,
      auditEffort: c.LLM_REASONING_EFFORT_AUDIT,
      reviewEffort: c.LLM_REASONING_EFFORT_REVIEW,
      imageDetail: c.LLM_IMAGE_DETAIL,
      store: c.LLM_STORE_RESPONSES,
      timeoutMs: c.LLM_TIMEOUT_MS,
      maxOutputTokens: c.LLM_MAX_OUTPUT_TOKENS,
      maxRetries: c.LLM_MAX_RETRIES, // SDK auto-retries; 0 for Gate A
      maxCallsPerLead: c.MAX_LLM_CALLS_PER_LEAD,
      maxGeneratorAttempts: c.LLM_MAX_GENERATOR_ATTEMPTS,
      maxReviewerAttempts: c.LLM_MAX_REVIEWER_ATTEMPTS,
      maxCostUsdPerLead: c.MAX_LLM_COST_USD_PER_LEAD,
      severeCaptureLimitations: opts?.severeCaptureLimitations ?? false,
      promptCacheEnabled: c.LLM_PROMPT_CACHE_ENABLED,
      worstCaseInputTokensPerCall: worstCaseInputTokens({
        maxEvidenceItems: c.MAX_LLM_EVIDENCE_ITEMS,
        maxImages: c.MAX_LLM_INPUT_IMAGES_PER_CALL,
      }),
    },
  });
  return { service, envelopes, uow, debug, providerName: provider.name };
}
