import { z } from 'zod';

/**
 * Structured LLM output for decision-maker extraction from a lead's own official website evidence.
 * Mirrors `src/domain/audit/audit-schema.ts`'s dual Zod + hand-built strict-JSON-Schema pattern: the
 * Zod schema validates the response AFTER the call; the JSON Schema is sent to the Responses API as
 * `text.format.json_schema` (strict mode) so the model cannot return an unrelated shape.
 *
 * TRUST vs HYGIENE. Zod here enforces only what makes the WHOLE response untrustworthy: the object
 * shape, the evidence-citation contract, and the confidence range. Per-candidate value quality (a
 * blank or absurd name/title, an over-long snippet) is deliberately NOT enforced here — one bad
 * candidate must never discard the other valid candidates in the same paid response. Those bounds
 * live in `service.ts` and either reject that single candidate (`unusable_field`) or normalize it.
 *
 * SCHEMA MIRRORING. Every constraint Zod enforces below is also expressed in
 * DECISION_MAKER_JSON_SCHEMA, using ONLY keywords OpenAI Structured Outputs supports for the
 * non-fine-tuned models we call (arrays: minItems/maxItems; numbers: minimum/maximum; strings:
 * pattern/format). String LENGTH keywords are deliberately never emitted — they are not in that
 * supported subset, and an unsupported keyword is rejected by the API at request time. Drift between
 * the two schemas is a test failure: see tests/unit/decision-makers-schema-contract.test.ts.
 *
 * Why not the OpenAI SDK's `zodTextFormat` helper: it derives the model-facing schema via zod v4's
 * `z.toJSONSchema`, which emits `maxLength`/`minLength` for every string `.max()`/`.min()`. That is
 * precisely the unsupported-keyword class above, and it would also re-impose model-side string
 * bounds that this module intentionally moved into deterministic normalization. Adopting it would
 * additionally mean reshaping `LlmRequest.outputSchema` for audit/email/composer/visual-review — a
 * larger refactor for a strictly worse contract. Hand-built + contract tests is the smaller, safer unit.
 */

// Bumped for the candidateRef removal: the model-facing contract changed shape (a required property
// was dropped) and gained mirrored array/number bounds.
export const DECISION_MAKER_SCHEMA_VERSION = 'decision-maker-schema-2';

/** Structural bounds — mirrored into the model-facing schema and fail-closed in Zod. */
export const MAX_CANDIDATES = 8;
export const MIN_EVIDENCE_IDS = 1;
export const MAX_EVIDENCE_IDS = 4;

/** Storage/display bounds applied deterministically AFTER validation — see `service.ts`. Never part
 * of the model-facing contract, and never a reason to discard a whole response. */
export const MAX_CANDIDATE_NAME_CHARS = 200;
export const MAX_CANDIDATE_TITLE_CHARS = 200;
export const MAX_EVIDENCE_SNIPPET_CHARS = 400;

export const decisionMakerCandidateSchema = z.object({
  /** Identity fields: length/blankness is checked per-candidate in `service.ts`, not here. */
  fullName: z.string(),
  title: z.string(),
  /** Model-facing evidence alias tags (e.g. "E1") this candidate's name+title came from. Must cite
   * at least one; resolved positionally against the pages actually sent by `resolvePageAlias` in
   * `service.ts`, which fails closed on any tag it cannot map. */
  evidenceIds: z.array(z.string().min(1)).min(MIN_EVIDENCE_IDS).max(MAX_EVIDENCE_IDS),
  confidence: z.number().min(0).max(1),
  /** Supporting/display text. Normalized to MAX_EVIDENCE_SNIPPET_CHARS in `service.ts`. */
  evidenceSnippet: z.string(),
});
export type DecisionMakerCandidateParsed = z.infer<typeof decisionMakerCandidateSchema>;

export const decisionMakerExtractionOutputSchema = z.object({
  // The model may propose more than the eventual max of 3 — the deterministic pipeline caps it.
  candidates: z.array(decisionMakerCandidateSchema).max(MAX_CANDIDATES),
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
    fullName: { type: 'string' },
    title: { type: 'string' },
    evidenceIds: { type: 'array', items: { type: 'string' }, minItems: MIN_EVIDENCE_IDS, maxItems: MAX_EVIDENCE_IDS },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    evidenceSnippet: { type: 'string' },
  },
  ['fullName', 'title', 'evidenceIds', 'confidence', 'evidenceSnippet'],
);

export const DECISION_MAKER_JSON_SCHEMA = strObj(
  {
    candidates: { type: 'array', items: candidateJson, maxItems: MAX_CANDIDATES },
    insufficientEvidence: { type: 'boolean' },
  },
  ['candidates', 'insufficientEvidence'],
);
