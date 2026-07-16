import pino from 'pino';
import { describe, expect, it } from 'vitest';
import {
  OpenAiResponsesProvider,
  type OpenAiClientLike,
  type OpenAiRequestOptions,
} from '../../src/integrations/llm/openai-responses.js';
import { type LlmRequest } from '../../src/integrations/llm/provider.js';

const logger = pino({ level: 'silent' });

function req(over: Partial<LlmRequest> = {}): LlmRequest {
  return {
    task: 'website_audit',
    system: 'sys',
    user: 'user',
    images: [{ id: 'a', mediaType: 'image/png', dataBase64: 'AAAA', detail: 'high' }],
    outputSchema: { type: 'object' },
    schemaName: 'website_audit',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    store: false,
    timeoutMs: 180_000,
    maxOutputTokens: 8000,
    maxRetries: 0,
    ...over,
  };
}

const okData = {
  id: 'resp_1',
  model: 'gpt-5.6-sol',
  status: 'completed',
  output_text: '{"ok":true}',
  output: [],
  usage: { input_tokens: 1000, output_tokens: 200, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 50 } },
};

/** Fake client that records the options passed to create and returns a fixed result. */
function fakeClient(behavior: { data?: unknown; throwErr?: Error }): { client: OpenAiClientLike; seen: { body?: unknown; options?: OpenAiRequestOptions } } {
  const seen: { body?: unknown; options?: OpenAiRequestOptions } = {};
  const client: OpenAiClientLike = {
    responses: {
      create(body: unknown, options?: OpenAiRequestOptions) {
        seen.body = body;
        seen.options = options;
        return {
          withResponse: async () => {
            if (behavior.throwErr) throw behavior.throwErr;
            return { data: behavior.data, request_id: 'req_abc' };
          },
        };
      },
    },
  };
  return { client, seen };
}

describe('OpenAiResponsesProvider timeout & retries wiring', () => {
  it('passes the configured LLM_TIMEOUT_MS to the SDK per request (no hardcoded 60s)', async () => {
    const { client, seen } = fakeClient({ data: okData });
    const p = new OpenAiResponsesProvider({ apiKey: 'x', logger, client });
    await p.generate(req({ timeoutMs: 180_000 }));
    expect(seen.options?.timeout).toBe(180_000);
  });

  it('applies maxRetries=0 to the SDK per request (no SDK-level auto-retries)', async () => {
    const { client, seen } = fakeClient({ data: okData });
    const p = new OpenAiResponsesProvider({ apiKey: 'x', logger, client });
    await p.generate(req({ maxRetries: 0 }));
    expect(seen.options?.maxRetries).toBe(0);
  });

  it('sends the documented request shape (strict json_schema, reasoning ctx, store, no tools/cache)', async () => {
    const { client, seen } = fakeClient({ data: okData });
    const p = new OpenAiResponsesProvider({ apiKey: 'x', logger, client });
    await p.generate(req());
    const body = seen.body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(body.model).toBe('gpt-5.6-sol');
    expect(body.text.format).toMatchObject({ type: 'json_schema', strict: true });
    expect(body.reasoning).toMatchObject({ effort: 'medium', context: 'current_turn' });
    expect(body.store).toBe(false);
    expect(body.tools).toBeUndefined();
    expect(body.previous_response_id).toBeUndefined();
    expect(body.prompt_cache_key).toBeUndefined(); // cache disabled by default
  });

  it('a timeout error maps to transient status with no fabricated metadata', async () => {
    const { client } = fakeClient({ throwErr: new Error('Request timed out.') });
    const p = new OpenAiResponsesProvider({ apiKey: 'x', logger, client });
    const r = await p.generate(req());
    expect(r.status).toBe('transient');
    expect(r.resolvedModel).toBeNull();
    expect(r.requestId).toBeNull();
    expect(r.usage.inputTokens).toBeNull();
    expect(r.usage.estimatedCostUsd).toBeNull();
  });

  it('parses a completed response into an ok result with usage + cost', async () => {
    const { client } = fakeClient({ data: okData });
    const p = new OpenAiResponsesProvider({ apiKey: 'x', logger, client });
    const r = await p.generate(req());
    expect(r.status).toBe('ok');
    expect(r.rawJson).toEqual({ ok: true });
    expect(r.resolvedModel).toBe('gpt-5.6-sol');
    expect(r.usage.inputTokens).toBe(1000);
    expect(r.usage.outputTokens).toBe(200);
    expect(r.usage.estimatedCostUsd).toBeGreaterThan(0);
    expect(r.requestId).toBe('req_abc');
  });
});
