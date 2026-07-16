import { type LlmProvider, type LlmRequest, type LlmResult } from './provider.js';

export type MockResponder = (req: LlmRequest, callIndex: number) => Partial<LlmResult> & { rawJson?: unknown };

/**
 * Deterministic LLM provider for standard tests and mock runs. Zero network, zero
 * cost. Tests supply a responder that returns the exact structured output (or a
 * refusal/incomplete/rate_limited status) per call. Records the full call log.
 */
export class MockLlmProvider implements LlmProvider {
  readonly name = 'mock';
  readonly calls: LlmRequest[] = [];

  constructor(private readonly responder: MockResponder) {}

  async generate(req: LlmRequest): Promise<LlmResult> {
    const index = this.calls.length;
    this.calls.push(req);
    const partial = this.responder(req, index);
    return {
      status: 'ok',
      rawJson: null,
      refusal: null,
      incompleteReason: null,
      provider: 'mock',
      requestedModel: req.model,
      resolvedModel: req.model,
      requestId: `mock-req-${index + 1}`,
      responseId: `mock-res-${index + 1}`,
      usage: {
        inputTokens: 200,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 120,
        reasoningTokens: 0,
        estimatedCostUsd: 0,
      },
      latencyMs: 1,
      imageDetail: req.images[0]?.detail ?? null,
      ...partial,
    };
  }
}
