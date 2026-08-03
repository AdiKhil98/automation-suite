/**
 * Phase 7A4B — shared types for the guarded live-model validation. A live run makes AT MOST one Terra
 * (base generation) call and one Sol (advisory critique) call. `LiveCallBudget` enforces the hard ceiling:
 * every model call must `reserve()` first, and exceeding the budget throws — never silently proceeds.
 */

import { type LlmResult } from '../../../integrations/llm/provider.js';

export type LiveModelRole = 'TERRA_BASE' | 'SOL_CRITIQUE';

export type CombinedOperatorStatus =
  | 'READY_FOR_OPERATOR_REVIEW'
  | 'REQUIRES_REVISION'
  | 'VALIDATION_FAILED';

/** Sanitized per-call metadata. NEVER carries API keys, headers, prompt text, or raw provider diagnostics. */
export interface LiveModelCall {
  role: LiveModelRole;
  provider: string;
  schemaName: string;
  requestedModel: string;
  resolvedModel: string | null;
  status: string;
  requestId: string | null;
  responseId: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  estimatedCostUsd: number | null;
  latencyMs: number;
  timestamp: string;
}

export class LiveBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveBudgetError';
  }
}

/** Hard ceiling on live model calls. Fails closed on the (budget+1)-th reservation. */
export class LiveCallBudget {
  private used = 0;
  constructor(private readonly max: number) {
    if (max < 0) throw new LiveBudgetError(`live call budget must be non-negative (got ${String(max)})`);
  }
  get callsMade(): number {
    return this.used;
  }
  get max_(): number {
    return this.max;
  }
  reserve(role: LiveModelRole): void {
    if (this.used >= this.max) {
      throw new LiveBudgetError(`live call budget of ${String(this.max)} exceeded (attempted ${role})`);
    }
    this.used += 1;
  }
}

/** Build the sanitized call record from a provider result (drops all prompt/secret material). */
export function toModelCall(role: LiveModelRole, schemaName: string, res: LlmResult, timestamp: string): LiveModelCall {
  return {
    role,
    provider: res.provider,
    schemaName,
    requestedModel: res.requestedModel,
    resolvedModel: res.resolvedModel,
    status: res.status,
    requestId: res.requestId,
    responseId: res.responseId,
    inputTokens: res.usage.inputTokens,
    cachedInputTokens: res.usage.cachedInputTokens,
    outputTokens: res.usage.outputTokens,
    reasoningTokens: res.usage.reasoningTokens,
    estimatedCostUsd: res.usage.estimatedCostUsd,
    latencyMs: res.latencyMs,
    timestamp,
  };
}
