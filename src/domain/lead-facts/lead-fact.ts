import { z } from 'zod';

/** Every supported fact type. Enforced in code and by a DB CHECK constraint. */
export const FACT_TYPES = [
  'business_name',
  'official_domain',
  'official_website_url',
  'official_location_page_url',
  'domain',
  'phone',
  'contact_email',
  'contact_form_url',
  'formatted_address',
  'latitude',
  'longitude',
  'city',
  'country',
  'category',
  'rating',
  'review_count',
  'business_status',
  'ownership_type',
  // Phase 8: additional demo inputs extracted from verified capture evidence.
  'services',
  'opening_hours',
  'booking_url',
  // Phase 13: recipient's verified IANA timezone (e.g. "Europe/Berlin") for scheduling.
  'contact_timezone',
] as const;
export const factTypeSchema = z.enum(FACT_TYPES);
export type FactType = z.infer<typeof factTypeSchema>;

/** Approved provenance for durable facts. Google Places content is never a source. */
export const factSourceTypeSchema = z.enum(['mock', 'manual', 'website']);
export type FactSourceType = z.infer<typeof factSourceTypeSchema>;

export const ownershipTypeSchema = z.enum(['INDEPENDENT', 'CHAIN', 'FRANCHISE', 'UNKNOWN']);
export type OwnershipType = z.infer<typeof ownershipTypeSchema>;

export const businessStatusSchema = z.enum([
  'OPERATIONAL',
  'CLOSED_TEMPORARILY',
  'CLOSED_PERMANENTLY',
  'UNKNOWN',
]);
export type BusinessStatus = z.infer<typeof businessStatusSchema>;

export interface LeadFact {
  id: string;
  leadId: string;
  factType: FactType;
  value: string;
  normalizedValue: string | null;
  sourceType: FactSourceType;
  sourceUrl: string | null;
  capturedAt: Date;
  confidence: number;
  supersededBy: string | null;
  supersededAt: Date | null;
  isCurrent: boolean;
}

/** Input to write/replace a current fact. */
export interface NewLeadFact {
  leadId: string;
  factType: FactType;
  value: string;
  normalizedValue: string | null;
  sourceType: FactSourceType;
  sourceUrl: string | null;
  capturedAt?: Date;
  confidence?: number;
}
