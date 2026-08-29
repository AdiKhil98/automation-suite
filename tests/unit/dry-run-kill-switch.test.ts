import { describe, it, expect } from 'vitest';
import { type Logger } from 'pino';
import { assertLiveCallsAllowed, DryRunLiveCallError } from '../../src/config/live-call-guard.js';
import { buildAuditService } from '../../src/cli/commands/audit-build.js';
import { PRICE_VERIFIED_AT, priceKnown } from '../../src/integrations/llm/pricing.js';

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;

describe('DRY_RUN global kill switch', () => {
  it('assertLiveCallsAllowed throws under dry-run, passes otherwise', () => {
    expect(() => assertLiveCallsAllowed(true, 'x')).toThrow(DryRunLiveCallError);
    expect(() => assertLiveCallsAllowed(true, 'x')).toThrow(/DRY_RUN=true blocks/);
    expect(() => assertLiveCallsAllowed(false, 'x')).not.toThrow();
  });

  it('audit LLM: DRY_RUN=true + ALLOW_PAID_LLM_CALLS=true + key + priced model → fail closed before network', () => {
    // Precondition: the model must be priced or the earlier price gate would fire first.
    const model = 'gpt-5.6-sol';
    expect(Boolean(PRICE_VERIFIED_AT) && priceKnown(model)).toBe(true);
    const ctx = {
      config: {
        LLM_PROVIDER: 'openai', ALLOW_PAID_LLM_CALLS: true, OPENAI_API_KEY: 'sk-test', LLM_MODEL_AUDIT: model,
        LLM_MODEL_REVIEW: model, DRY_RUN: true,
      },
      logger,
    } as unknown as Parameters<typeof buildAuditService>[0];
    expect(() => buildAuditService(ctx)).toThrow(/DRY_RUN=true blocks/);
  });

  it('audit LLM: the paid-flag error still fires first when ALLOW_PAID_LLM_CALLS is off (existing behavior preserved)', () => {
    const ctx = {
      config: { LLM_PROVIDER: 'openai', ALLOW_PAID_LLM_CALLS: false, OPENAI_API_KEY: 'sk-test', LLM_MODEL_AUDIT: 'gpt-5.6-sol', DRY_RUN: true },
      logger,
    } as unknown as Parameters<typeof buildAuditService>[0];
    expect(() => buildAuditService(ctx)).toThrow(/ALLOW_PAID_LLM_CALLS/);
  });
});
