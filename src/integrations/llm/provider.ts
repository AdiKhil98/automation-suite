export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ImageDetail = 'low' | 'high' | 'auto' | 'original';

export interface LlmImage {
  id: string;
  mediaType: string;
  dataBase64: string;
  detail: ImageDetail;
}

export interface LlmCacheConfig {
  enabled: boolean;
  mode: 'implicit' | 'explicit';
  ttl: '30m';
  key: string; // stable, partitioned by task|model|prompt|rubric|schema — never lead-specific
}

export interface LlmRequest {
  task: 'website_audit' | 'audit_review' | 'demo_design' | 'demo_design_review' | 'email_write' | 'email_review' | 'decision_maker_extraction';
  system: string;
  user: string;
  images: LlmImage[];
  outputSchema: Record<string, unknown>;
  schemaName: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  store: boolean;
  timeoutMs: number;
  maxOutputTokens: number;
  maxRetries: number;
  cache?: LlmCacheConfig;
}

export type LlmStatus =
  | 'ok'
  | 'refusal'
  | 'incomplete'
  | 'schema_invalid'
  | 'rate_limited'
  | 'transient'
  | 'input_too_large';

export interface LlmUsage {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  estimatedCostUsd: number | null;
}

export interface LlmResult {
  status: LlmStatus;
  rawJson: unknown | null; // parsed structured output; validated by the caller
  refusal: string | null;
  incompleteReason: string | null;
  provider: string;
  requestedModel: string;
  resolvedModel: string | null;
  requestId: string | null;
  responseId: string | null;
  usage: LlmUsage;
  latencyMs: number;
  imageDetail: ImageDetail | null;
}

/** Provider-agnostic LLM boundary. OpenAI-specific types never cross this line. */
export interface LlmProvider {
  readonly name: string;
  generate(req: LlmRequest): Promise<LlmResult>;
}
