import { z } from 'zod';

/**
 * A single execution of the pipeline (or a stage of it). Runs are resumable and
 * every event can be attributed to a run. Fully exercised from Phase 12; the
 * entity exists now so events have a stable foreign key from the start.
 */
export const pipelineRunStatusSchema = z.enum(['RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED']);
export type PipelineRunStatus = z.infer<typeof pipelineRunStatusSchema>;

export const pipelineRunSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  status: pipelineRunStatusSchema,
  dryRun: z.boolean(),
  startedAt: z.date(),
  finishedAt: z.date().nullable(),
  notes: z.string().nullable(),
});
export type PipelineRun = z.infer<typeof pipelineRunSchema>;
