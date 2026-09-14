import { z } from 'zod';
import {
  DEMO_ALIGNMENT_RESULTS,
  EMAIL_COMPETITOR_EVIDENCE_MODES,
  MAX_SUBJECT_LENGTH,
  PRIMARY_CTAS,
  REVIEW_DECISIONS,
  SCAN_RESULTS,
} from './email-types.js';

// Bumped once for Phase 7A3B: `competitor_evidence_used` widened from the NONE-only literal to the
// NONE | APPROVED_COMPETITOR_PATTERN_PACKAGE union. Prospect-only emails (raw model output = NONE)
// remain fully compatible; the enriched value is set by the deterministic composer on the final artifact.
// Bumped again for the sequence-aware reviewer: four fail-closed sequence-job booleans were added
// (addsClarityNotRestart, compressedNotExpanded, pressureReduced, binaryReplyClose). Writer output
// is unchanged.
export const EMAIL_SCHEMA_VERSION = 'email-copy-schema-4';

export const emailWriterSchema = z.object({
  subject_options: z.array(z.string().trim().min(1).max(MAX_SUBJECT_LENGTH)).length(3),
  selected_subject: z.string().trim().min(1).max(MAX_SUBJECT_LENGTH),
  selected_subject_reason: z.string().trim().min(1).max(400),
  email_body: z.string().trim().min(1).max(2_000),
  evidence_ids: z.array(z.string().trim().min(1).max(128)).min(1).max(12),
  strategic_angle: z.string().trim().min(1).max(400),
  business_relevance: z.string().trim().min(1).max(500),
  urgency_basis: z.string().trim().min(1).max(400),
  competitor_evidence_used: z.enum(EMAIL_COMPETITOR_EVIDENCE_MODES),
  primary_cta: z.enum(PRIMARY_CTAS),
  prohibited_phrase_scan: z.enum(SCAN_RESULTS),
  punctuation_scan: z.enum(SCAN_RESULTS),
  genericity_score: z.number().int().min(0).max(100),
  human_style_result: z.enum(SCAN_RESULTS),
  demo_alignment_result: z.enum(DEMO_ALIGNMENT_RESULTS),
});
export type EmailWriterParsed = z.infer<typeof emailWriterSchema>;

export const emailReviewSchema = z.object({
  decision: z.enum(REVIEW_DECISIONS),
  fabricationRisk: z.boolean(),
  subjectSpecific: z.boolean(),
  subjectCuriosityGap: z.boolean(),
  openingSpecific: z.boolean(),
  businessRelevanceClear: z.boolean(),
  urgencySupported: z.boolean(),
  competitorClaimsSupported: z.boolean(),
  humanStylePass: z.boolean(),
  punctuationPass: z.boolean(),
  singlePrimaryCta: z.boolean(),
  sufficientlyPersonalized: z.boolean(),
  evidenceSupported: z.boolean(),
  demoAligned: z.boolean(),
  persuasive: z.boolean(),
  // Day-1 single-observation quality gate. All four are fail-closed and required for APPROVE.
  singleObservation: z.boolean(),
  buyerLanguageOnly: z.boolean(),
  conversationNotAudit: z.boolean(),
  confidentObservation: z.boolean(),
  // Sequence-job gate. Every step reports all four; `isEmailReviewApprovable` enforces exactly the
  // subset that applies to the step under review (see `email-review-gate.ts`).
  addsClarityNotRestart: z.boolean(),
  compressedNotExpanded: z.boolean(),
  pressureReduced: z.boolean(),
  binaryReplyClose: z.boolean(),
  problems: z.array(z.string().trim().min(1).max(300)).max(20),
  requiredRevisions: z.array(z.string().trim().min(1).max(300)).max(20),
});
export type EmailReviewParsed = z.infer<typeof emailReviewSchema>;

/**
 * The schema sent to the provider is DERIVED from the Zod schema above — never hand-written
 * alongside it.
 *
 * WHY. These two schemas are one contract with two enforcement points: the provider constrains what
 * the model may emit, and Zod decides what this process will accept. When the provider copy was
 * maintained by hand it drifted: `problems` / `requiredRevisions` shipped as a bare
 * `{ type: 'array', items: { type: 'string' } }` while Zod required at most 20 entries of 1-300
 * characters, and every writer string constraint (subject, body, reason, evidence-id lengths, the
 * evidence-id count) was likewise absent. A model could then return output that satisfied the
 * provider schema and still failed local parsing — a PAID call that could never succeed. Deriving
 * the wire schema makes that class of bug unrepresentable: tighten Zod and the provider tightens
 * with it.
 *
 * WHAT IS ADJUSTED. Structured outputs additionally require that every property is listed in
 * `required` and that objects refuse extra keys, and they have no use for the `$schema` dialect
 * marker. Those are enforced here rather than assumed — a Zod change that made a field optional
 * would throw at module load instead of silently loosening the wire contract.
 *
 * WHAT CANNOT BE EXPRESSED. Zod's `.trim()` runs BEFORE its length checks, so a whitespace-only
 * string satisfies `minLength: 1` on the wire and still fails Zod. JSON Schema cannot express
 * "length after trimming", and a `pattern` keyword is not worth the risk of a provider rejecting
 * the whole schema, so this one difference stays — and is exactly why a schema-invalid reviewer
 * response must remain durably auditable (see `resume-email-review.ts`).
 */
function providerJsonSchema(schema: z.ZodType, name: string): Record<string, unknown> {
  const derived = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  const { $schema: _dialect, ...rest } = derived;
  const properties = rest.properties as Record<string, unknown> | undefined;
  if (!properties || Object.keys(properties).length === 0) {
    throw new Error(`${name}: derived provider schema has no properties`);
  }
  const required = new Set((rest.required as string[] | undefined) ?? []);
  const optional = Object.keys(properties).filter((key) => !required.has(key));
  if (optional.length > 0) {
    throw new Error(`${name}: structured outputs require every field; these are optional: ${optional.join(', ')}`);
  }
  return { ...rest, additionalProperties: false };
}

export const EMAIL_WRITER_JSON_SCHEMA = providerJsonSchema(emailWriterSchema, 'EMAIL_WRITER_JSON_SCHEMA');
export const EMAIL_REVIEW_JSON_SCHEMA = providerJsonSchema(emailReviewSchema, 'EMAIL_REVIEW_JSON_SCHEMA');
