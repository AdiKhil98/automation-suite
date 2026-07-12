import { z } from 'zod';
import { leadStatusSchema } from '../leads/status.js';

/**
 * Append-only audit record. Every state transition (valid or invalid) and other
 * notable pipeline occurrence writes one of these, giving a complete, inspectable
 * history for each lead.
 */
export const pipelineEventTypeSchema = z.enum([
  'LEAD_CREATED',
  'STATE_TRANSITION',
  'INVALID_TRANSITION',
  'NOTE',
  // Collection (Phase 2)
  'LEAD_COLLECTED',
  'LEAD_DUPLICATE',
  'LEAD_BRANCH',
  'LEAD_AMBIGUOUS',
  'LEAD_REJECTED',
  'SOURCE_REFRESHED',
]);
export type PipelineEventType = z.infer<typeof pipelineEventTypeSchema>;

export const pipelineEventSchema = z.object({
  id: z.string().min(1),
  leadId: z.string().nullable(),
  runId: z.string().nullable(),
  type: pipelineEventTypeSchema,
  fromStatus: leadStatusSchema.nullable(),
  toStatus: leadStatusSchema.nullable(),
  message: z.string().nullable(),
  data: z.unknown().nullable(),
  createdAt: z.date(),
});
export type PipelineEvent = z.infer<typeof pipelineEventSchema>;

/** Input for recording an event; id/createdAt are assigned by persistence. */
export type NewPipelineEvent = {
  leadId: string | null;
  runId: string | null;
  type: PipelineEventType;
  fromStatus: LeadStatusOrNull;
  toStatus: LeadStatusOrNull;
  message: string | null;
  data: unknown;
};

type LeadStatusOrNull = z.infer<typeof leadStatusSchema> | null;
