import { PRICE_VERIFIED_AT, priceKnown } from '../../integrations/llm/pricing.js';
import { AppError } from '../../utils/errors.js';

/**
 * WHICH email provider a run is allowed to use — pure, no construction, no network.
 *
 * Two separate questions live here, and conflating them is exactly the hazard this module exists
 * to remove:
 *
 *  1. "May this process make PAID calls?" — the long-standing hard gate: `LLM_PROVIDER=openai`
 *     plus `ALLOW_PAID_LLM_CALLS=true`, an API key, and a verified price for every model used.
 *     Off by default; a missing piece throws before any lead is touched.
 *
 *  2. "Is a MOCK provider acceptable here?" — for most commands, yes: mock is the free default and
 *     producing fixture copy on a developer machine is the point. For UNATTENDED FOLLOW-UP
 *     PREPARATION it is not. That runner persists its output straight into the human review queue
 *     as a real `email_drafts` row for a real prospect, so a box that is armed for production but
 *     accidentally left on the default provider would quietly fill the operator's queue with
 *     fixture text ("A clearer contact path for …") that reads like real, reviewable copy.
 *
 * `ALLOW_PAID_LLM_CALLS=true` alone does NOT answer question 2: it only PERMITS spending, it does
 * not SELECT a provider. Production must therefore state the provider explicitly, and unattended
 * preparation refuses to run on a mock unless an operator has deliberately opted in.
 */

/** The provider-selection slice of config these policies read. Nothing else is consulted. */
export interface EmailProviderConfigView {
  llmProvider: string;
  allowPaidLlmCalls: boolean;
  openAiApiKey: string | undefined;
  writerModel: string;
  reviewerModel: string;
}

/**
 * Every precondition a LIVE (paid) OpenAI email provider must satisfy. Throws on the first failure
 * and constructs nothing, so callers can run it eagerly as a preflight and still build the provider
 * itself lazily. Returns the validated credential so the builder needs no second, weaker check.
 */
export function requireLiveEmailProviderConfig(c: EmailProviderConfigView): { apiKey: string } {
  if (!c.allowPaidLlmCalls) throw new Error('LLM_PROVIDER=openai requires ALLOW_PAID_LLM_CALLS=true (paid-call kill switch is off).');
  if (!c.openAiApiKey) throw new Error('LLM_PROVIDER=openai requires OPENAI_API_KEY.');
  if (!PRICE_VERIFIED_AT) throw new Error('LLM price table not verified; reconcile pricing.ts before any paid call.');
  if (!priceKnown(c.writerModel)) throw new Error(`No verified price for email writer model "${c.writerModel}".`);
  if (!priceKnown(c.reviewerModel)) throw new Error(`No verified price for email reviewer model "${c.reviewerModel}".`);
  return { apiKey: c.openAiApiKey };
}

/**
 * The preflight for UNATTENDED follow-up preparation, run AFTER the feature gates pass and BEFORE
 * any candidate is listed, composed, or persisted. Fail-closed in both directions:
 *
 *  - a mock/unknown provider is refused outright (no fixture copy can reach the review queue),
 *    unless `allowMockLlm` was deliberately set;
 *  - a live provider with incomplete configuration (no key, unverified prices, unpriced model) is
 *    refused by the same checks the provider builder uses, so the run fails loudly on a
 *    misconfigured box instead of failing silently per-candidate.
 */
export function assertUnattendedPreparationProvider(
  c: EmailProviderConfigView & { allowMockLlm: boolean },
): void {
  if (c.llmProvider !== 'openai') {
    if (!c.allowMockLlm) {
      throw new AppError(
        'FOLLOWUP_PREPARATION_PROVIDER_REFUSED',
        `Unattended follow-up preparation requires a live model provider, but LLM_PROVIDER="${c.llmProvider}". ` +
          'Set LLM_PROVIDER=openai (production does this in the follow-up systemd drop-in, never in .env), ' +
          'or set FOLLOWUP_PREPARATION_ALLOW_MOCK_LLM=true to deliberately accept MOCK copy in the human review queue.',
      );
    }
    return;
  }
  requireLiveEmailProviderConfig(c);
}
