# OpenAI Responses API — verified contract (Phase 6)

**SDK verified:** `openai@6.46.0` (pinned exact). **Verified against:** the installed SDK's own
TypeScript definitions (`node_modules/openai/resources/responses/responses.d.ts`, `resources/shared.d.ts`).
**Verified at:** 2026-07-14. Fields the SDK marks optional/sometimes-absent are modeled as **nullable** in our
adapter — never fabricated.

## Endpoint / SDK call
`client.responses.create(params)` (Responses API, not Chat Completions). Request id is read via
`client.responses.create(params).withResponse()` → `{ data, request_id }`.

## Request shape (fields we use)
- `model: Shared.ResponsesModel` — supports `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`.
- `instructions: string` — system prompt (stable, cacheable prefix).
- `input: Array<ResponseInputItem>` — user turn = content parts `input_text` and `input_image`.
  - `input_image.detail: 'low' | 'high' | 'auto' | 'original'`. **For GPT-5.6, `auto` behaves like
    `original`** (not a cheaper middle tier); default we use is `high`.
  - `input_image` / `input_text` support `prompt_cache_breakpoint: { mode: 'explicit' }`.
- `text.format: { type: 'json_schema', name, schema, strict: true }` with `additionalProperties: false`.
- `reasoning: { effort: 'none'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max', context: 'current_turn' }`.
  Default effort `medium`. (The SDK `Reasoning` type has **no `mode` field**; "pro mode" is therefore not a
  Responses request field in this SDK — deferred/not implemented, never faked.)
- `store: false`.
- `max_output_tokens`, and per-request timeout/retries via SDK client options.
- `prompt_cache_key?: string` + `prompt_cache_options?: { mode: 'implicit'|'explicit', ttl: '30m' }`.
- **Not used:** `tools`, `previous_response_id` (reviewer stays independent), persisted reasoning.

## Response shape (fields we read)
- `id` (response id), `model` (resolved model name), `status`, `incomplete_details` (nullable).
- Output content parts include a refusal part: `{ type: 'refusal', refusal: string }`.
- `usage`: `input_tokens`, `input_tokens_details.cached_tokens`, `input_tokens_details.cache_write_tokens`,
  `output_tokens`, `output_tokens_details.reasoning_tokens`.
- `request_id` via `.withResponse()`.

## Handling
- **Refusal:** any `refusal` output part → outcome `MODEL_REFUSAL`.
- **Incomplete:** `status !== 'completed'` or `incomplete_details != null` → `INCOMPLETE` (retry once, else review).
- **Schema:** parse structured output with Zod; failure → `SCHEMA_INVALID` (one bounded repair).
- Optional/absent metadata (cached/cache-write/reasoning tokens, request id) → `null`, never invented.

## Prompt caching (implemented, off by default)
`prompt_cache_options.mode = 'explicit'`, `ttl = '30m'`. Explicit `prompt_cache_breakpoint` placed after the
stable prefix (system + rubric + category defs + schema + safety). Dynamic lead evidence + images come after.
Cache keys are stable and partitioned by `task | model | promptVersion | rubricVersion | schemaVersion` and
never include lead ids / business names / domains / evidence. Generator and reviewer use different keys.

## Pricing (RECONCILED 2026-07-15)
Local price table `src/integrations/llm/pricing.ts` — `PRICE_TABLE_VERSION='llm-prices-2'`,
`PRICE_VERIFIED_AT='2026-07-15'`, source: official OpenAI API pricing page
(https://developers.openai.com/api/docs/pricing), values supplied and verified by the operator on 2026-07-15.

**gpt-5.6-sol, Standard processing, USD per 1M tokens:**

| Tier | Input | Cached input | Cache write | Output |
|---|---|---|---|---|
| Short context | 5.00 | 0.50 | 6.25 | 30.00 |
| Long context | 10.00 | 1.00 | 12.50 | 45.00 |

Only `gpt-5.6-sol` has a verified row; any other model (`terra`, `luna`, …) is **blocked** from paid calls
until its prices are verified and added.

**Context-tier determination:** per call, from the response's reported `usage.input_tokens` against
`SHORT_CONTEXT_MAX_INPUT_TOKENS = 128_000` — the most conservative plausible boundary (published boundaries
are ≥128k; our evidence/image caps bound worst-case input <40k tokens, so our calls are 'short' under any
actual boundary; inputs above it are billed at the long tier — over-estimating, never under). If
`input_tokens` is absent, the tier is undeterminable → `estimateCostUsd` returns **null**, and the audit
service treats a null cost from a real provider as unaccountable spend and **blocks all further calls**
(`BUDGET_BLOCKED`). Reasoning tokens are billed as output tokens and are included in (capped by)
`max_output_tokens`. Prompt caching stays **disabled for Gate A** (cache writes bill above plain input).
