import { z } from 'zod';
import { leadStatusSchema } from './status.js';

export const leadPrioritySchema = z.enum(['HIGH', 'MEDIUM', 'LOW']);
export type LeadPriority = z.infer<typeof leadPrioritySchema>;

/**
 * Domain representation of a lead. Persistence maps to/from this shape; no module
 * outside src/persistence should depend on database row types.
 */
export const leadSchema = z.object({
  id: z.string().min(1),
  businessName: z.string().min(1),
  normalizedName: z.string().min(1),
  domain: z.string().nullable(),
  normalizedDomain: z.string().nullable(),
  placeId: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string().nullable(),
  status: leadStatusSchema,
  priority: leadPrioritySchema.nullable(),
  source: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Lead = z.infer<typeof leadSchema>;

/**
 * Input for creating a lead. Identity/derived fields (id, normalized*, status,
 * timestamps) are assigned by the domain/persistence layer, not the caller.
 */
export const newLeadSchema = z.object({
  businessName: z.string().min(1),
  domain: z.string().nullable().default(null),
  placeId: z.string().nullable().default(null),
  city: z.string().nullable().default(null),
  country: z.string().nullable().default(null),
  priority: leadPrioritySchema.nullable().default(null),
  source: z.string().nullable().default(null),
});
/** Input shape: defaulted fields are optional for callers. */
export type NewLead = z.input<typeof newLeadSchema>;
/** Output shape after parsing: all fields present (defaults applied). */
export type ParsedNewLead = z.output<typeof newLeadSchema>;
