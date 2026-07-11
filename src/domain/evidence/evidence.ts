import { z } from 'zod';

/**
 * Evidence backing any personalization claim. The email writer (Phase 8) may use
 * only stored, approved evidence — this schema is the contract for what "stored"
 * means. Confidence is a 0..1 scalar.
 */
export const evidenceSourceTypeSchema = z.enum([
  'google_places',
  'website_html',
  'website_screenshot',
  'website_metadata',
  'competitor_website',
  'manual',
]);
export type EvidenceSourceType = z.infer<typeof evidenceSourceTypeSchema>;

export const evidenceSchema = z.object({
  id: z.string().min(1),
  leadId: z.string().min(1),
  sourceType: evidenceSourceTypeSchema,
  sourceUrl: z.string().nullable(),
  capturedAt: z.string().min(1),
  claim: z.string().min(1),
  rawEvidence: z.string(),
  confidence: z.number().min(0).max(1),
  screenshotPath: z.string().optional(),
  selector: z.string().optional(),
});
export type Evidence = z.infer<typeof evidenceSchema>;
