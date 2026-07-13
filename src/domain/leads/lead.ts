import { z } from 'zod';
import { leadStatusSchema } from './status.js';

export const leadPrioritySchema = z.enum(['HIGH', 'MEDIUM', 'LOW']);
export type LeadPriority = z.infer<typeof leadPrioritySchema>;

export const dedupStatusSchema = z.enum(['UNIQUE', 'AMBIGUOUS']);
export type DedupStatus = z.infer<typeof dedupStatusSchema>;

/**
 * Domain representation of a lead. Persistence maps to/from this shape.
 *
 * Business facts (name, domain, phone, address, coordinates) are nullable: a
 * Google Places discovery produces a Place-ID-only candidate with all facts NULL,
 * to be enriched later from independent public sources. Mock/manual providers
 * populate facts directly. `factsSource` records where durable facts came from and
 * must never be 'google_places'.
 */
export const leadSchema = z.object({
  id: z.string().min(1),
  businessName: z.string().nullable(),
  normalizedName: z.string().nullable(),
  domain: z.string().nullable(),
  normalizedDomain: z.string().nullable(),
  phone: z.string().nullable(),
  normalizedPhone: z.string().nullable(),
  formattedAddress: z.string().nullable(),
  normalizedAddress: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  placeId: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string().nullable(),
  status: leadStatusSchema,
  priority: leadPrioritySchema.nullable(),
  source: z.string().nullable(),
  dedupStatus: dedupStatusSchema,
  duplicateOf: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Lead = z.infer<typeof leadSchema>;

// NOTE: as of Phase 3, per-fact provenance lives in `lead_facts`. The leads.* fact
// columns are a derived current-value projection; lead-level provenance columns
// (facts_source/url/captured_at) are deprecated and no longer read or written.

/**
 * Input for creating a lead with full facts (mock/manual providers and the
 * create-sample-leads command). Google candidates use buildCandidateLead instead.
 */
export const newLeadSchema = z.object({
  businessName: z.string().min(1),
  domain: z.string().nullable().default(null),
  phone: z.string().nullable().default(null),
  placeId: z.string().nullable().default(null),
  city: z.string().nullable().default(null),
  country: z.string().nullable().default(null),
  formattedAddress: z.string().nullable().default(null),
  latitude: z.number().nullable().default(null),
  longitude: z.number().nullable().default(null),
  priority: leadPrioritySchema.nullable().default(null),
  source: z.string().nullable().default(null),
});
/** Input shape: defaulted fields are optional for callers. */
export type NewLead = z.input<typeof newLeadSchema>;
/** Output shape after parsing: all fields present (defaults applied). */
export type ParsedNewLead = z.output<typeof newLeadSchema>;
