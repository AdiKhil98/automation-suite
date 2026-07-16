import OpenAI from 'openai';
import { type Logger } from 'pino';
import { estimateCostUsd } from './pricing.js';
import { type LlmProvider, type LlmRequest, type LlmResult, type LlmStatus, type LlmUsage } from './provider.js';

/** Per-request options handed to the SDK. `timeout`/`maxRetries` come from config
 * (LLM_TIMEOUT_MS / maxRetries) — never hardcoded — so "no retries" covers SDK-level
 * automatic retries too. */
export interface OpenAiRequestOptions {
  timeout?: number;
  maxRetries?: number;
}

/** Minimal shape of the OpenAI client we depend on; lets tests inject a fake. */
export interface OpenAiClientLike {
  responses: {
    create(body: unknown, options?: OpenAiRequestOptions): { withResponse(): Promise<{ data: unknown; request_id?: string | null }> };
  };
}

export interface OpenAiProviderOptions {
  apiKey: string;
  logger: Logger;
  /** Test seam: inject a fake client. Production builds the real SDK client. */
  client?: OpenAiClientLike;
}

/**
 * OpenAI Responses API adapter. Verified against openai@6.46.0 (see
 * docs/integrations/openai-responses.md). Uses text.format json_schema (strict),
 * reasoning.context='current_turn', store=false, NO tools, NO previous_response_id.
 * Optional/absent metadata is returned as null — never fabricated. Only exercised at
 * the approved live Gate A; standard tests use MockLlmProvider.
 */
export class OpenAiResponsesProvider implements LlmProvider {
  readonly name = 'openai';
  private readonly client: OpenAiClientLike;

  constructor(private readonly opts: OpenAiProviderOptions) {
    // No hardcoded timeout. Client-level maxRetries defaults to 0 (belt-and-suspenders);
    // the authoritative per-request timeout/maxRetries are passed on each call below.
    this.client = opts.client ?? (new OpenAI({ apiKey: opts.apiKey, maxRetries: 0 }) as unknown as OpenAiClientLike);
  }

  async generate(req: LlmRequest): Promise<LlmResult> {
    const started = Date.now();
    const content: Array<Record<string, unknown>> = [{ type: 'input_text', text: req.user }];
    for (const img of req.images) {
      content.push({ type: 'input_image', image_url: `data:${img.mediaType};base64,${img.dataBase64}`, detail: img.detail });
    }

    const params: Record<string, unknown> = {
      model: req.model,
      instructions: req.system,
      input: [{ role: 'user', content }],
      text: { format: { type: 'json_schema', name: req.schemaName, schema: req.outputSchema, strict: true } },
      reasoning: { effort: req.reasoningEffort, context: 'current_turn' },
      store: req.store,
      max_output_tokens: req.maxOutputTokens,
    };
    if (req.cache?.enabled) {
      params.prompt_cache_key = req.cache.key;
      params.prompt_cache_options = { mode: req.cache.mode, ttl: req.cache.ttl };
    }

    const emptyUsage: LlmUsage = { inputTokens: null, cachedInputTokens: null, cacheWriteTokens: null, outputTokens: null, reasoningTokens: null, estimatedCostUsd: null };
    const fail = (status: LlmStatus, detail: string): LlmResult => ({
      status, rawJson: null, refusal: null, incompleteReason: status === 'incomplete' ? detail : null,
      provider: this.name, requestedModel: req.model, resolvedModel: null, requestId: null, responseId: null,
      usage: emptyUsage, latencyMs: Date.now() - started, imageDetail: req.images[0]?.detail ?? null,
    });

    let response: unknown;
    let requestId: string | null;
    try {
      // Per-request timeout + maxRetries from config — honors LLM_TIMEOUT_MS and the
      // "no SDK retries" rule (maxRetries is 0 for Gate A).
      const withResp = await this.client.responses
        .create(params, { timeout: req.timeoutMs, maxRetries: req.maxRetries })
        .withResponse();
      response = withResp.data;
      requestId = withResp.request_id ?? null;
    } catch (err) {
      const status = err instanceof OpenAI.RateLimitError ? 'rate_limited' : 'transient';
      this.opts.logger.warn({ status, err: err instanceof Error ? err.message : String(err) }, 'openai call failed');
      return fail(status, 'provider_error');
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = response as any;
    const usageRaw = r.usage ?? {};
    const usage: LlmUsage = {
      inputTokens: usageRaw.input_tokens ?? null,
      cachedInputTokens: usageRaw.input_tokens_details?.cached_tokens ?? null,
      cacheWriteTokens: usageRaw.input_tokens_details?.cache_write_tokens ?? null,
      outputTokens: usageRaw.output_tokens ?? null,
      reasoningTokens: usageRaw.output_tokens_details?.reasoning_tokens ?? null,
      estimatedCostUsd: null,
    };
    const resolvedModel: string | null = r.model ?? null;
    usage.estimatedCostUsd = resolvedModel ? estimateCostUsd(resolvedModel, usage) : null;

    const base = {
      provider: this.name, requestedModel: req.model, resolvedModel, requestId,
      responseId: (r.id as string | undefined) ?? null, usage, latencyMs: Date.now() - started,
      imageDetail: req.images[0]?.detail ?? null,
    };

    // Refusal detection.
    const refusalPart = (r.output ?? []).flatMap((o: { content?: Array<{ type?: string; refusal?: string }> }) => o.content ?? []).find((c: { type?: string }) => c.type === 'refusal');
    if (refusalPart) return { ...base, status: 'refusal', rawJson: null, refusal: refusalPart.refusal ?? 'refused', incompleteReason: null };

    if (r.status && r.status !== 'completed') {
      return { ...base, status: 'incomplete', rawJson: null, refusal: null, incompleteReason: r.incomplete_details?.reason ?? r.status };
    }

    const text: string = r.output_text ?? '';
    let rawJson: unknown;
    try {
      rawJson = JSON.parse(text);
    } catch {
      return { ...base, status: 'schema_invalid', rawJson: null, refusal: null, incompleteReason: null };
    }
    return { ...base, status: 'ok', rawJson, refusal: null, incompleteReason: null };
  }
}
