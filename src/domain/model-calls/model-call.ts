import { z } from 'zod';

/**
 * Record of a single LLM call: which prompt/model, token usage, and estimated
 * cost. Defined as a type now (per ARCHITECTURE.md §5) so cost accounting is
 * designed in from the start; the backing table is introduced in Phase 5 when the
 * first real model call exists. Secrets are never part of this record.
 */
export const modelCallSchema = z.object({
  id: z.string().min(1),
  leadId: z.string().nullable(),
  runId: z.string().nullable(),
  task: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  promptName: z.string().nullable(),
  promptVersion: z.string().nullable(),
  reasoningEffort: z.enum(['none', 'low', 'medium', 'high', 'max']).nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  cachedInputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  estimatedCostUsd: z.number().nonnegative().nullable(),
  succeeded: z.boolean(),
  createdAt: z.string().min(1),
});
export type ModelCall = z.infer<typeof modelCallSchema>;
