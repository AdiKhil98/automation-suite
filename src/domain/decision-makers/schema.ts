import { z } from 'zod';

/**
 * Structured LLM output for decision-maker extraction from a lead's own official website evidence.
 * Mirrors `src/domain/audit/audit-schema.ts`'s dual Zod + hand-built strict-JSON-Schema pattern: the
 * Zod schema validates the response AFTER the call; the JSON Schema is sent to the Responses API as
 * `text.format.json_schema` (strict mode) so the model cannot return an unrelated shape.
 */

export const DECISION_MAKER_SCHEMA_VERSION = 'decision-maker-schema-1';

export const decisionMakerCandidateSchema = z.object({
  candidateRef: z.string().min(1).max(16),
  fullName: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  /** Model-facing evidence alias tags (e.g. "E1") this candidate's name+title came from. Must cite
   * at least one; resolved/validated against the actual evidence sent — see evidence-alias.ts. */
  evidenceIds: z.array(z.string().min(1)).min(1).max(4),
  confidence: z.number().min(0).max(1),
  evidenceSnippet: z.string().min(1).max(400),
});
export type DecisionMakerCandidateParsed = z.infer<typeof decisionMakerCandidateSchema>;

export const decisionMakerExtractionOutputSchema = z.object({
  // The model may propose more than the eventual max of 3 — the deterministic pipeline caps it.
  candidates: z.array(decisionMakerCandidateSchema).max(8),
  insufficientEvidence: z.boolean(),
});
export type DecisionMakerExtractionOutputParsed = z.infer<typeof decisionMakerExtractionOutputSchema>;

const strObj = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: 'object',
  additionalProperties: false,
  required,
  properties,
});

const candidateJson = strObj(
  {
    candidateRef: { type: 'string' },
    fullName: { type: 'string' },
    title: { type: 'string' },
    evidenceIds: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number' },
    evidenceSnippet: { type: 'string' },
  },
  ['candidateRef', 'fullName', 'title', 'evidenceIds', 'confidence', 'evidenceSnippet'],
);

export const DECISION_MAKER_JSON_SCHEMA = strObj(
  {
    candidates: { type: 'array', items: candidateJson },
    insufficientEvidence: { type: 'boolean' },
  },
  ['candidates', 'insufficientEvidence'],
);
