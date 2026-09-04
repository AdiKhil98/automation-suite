import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DECISION_MAKER_JSON_SCHEMA,
  DECISION_MAKER_SCHEMA_VERSION,
  decisionMakerExtractionOutputSchema,
  MAX_CANDIDATES,
  MAX_EVIDENCE_IDS,
  MIN_EVIDENCE_IDS,
} from '../../src/domain/decision-makers/schema.js';
import { buildExtractorMessages } from '../../src/prompts/decision-makers/index.js';

/**
 * Guards the dual-schema boundary that caused the first live canary to fail closed: the local Zod
 * validator demanded `candidateRef` be <=16 characters, a constraint that appeared NOWHERE in the
 * JSON Schema sent to OpenAI and NOWHERE in the prompt. The model obeyed the contract it was given;
 * our validator then rejected the whole paid response.
 *
 * These tests fail on any future drift of the same shape.
 */

/** Keywords OpenAI Structured Outputs supports for the non-fine-tuned models we call. Anything Zod
 * declares outside this set (notably string maxLength/minLength) is intentionally NOT mirrored — an
 * unsupported keyword is rejected by the API at request time. */
const SUPPORTED_ARRAY_KEYWORDS = ['minItems', 'maxItems'] as const;
const SUPPORTED_NUMBER_KEYWORDS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'] as const;
const SUPPORTED_STRING_KEYWORDS = ['pattern', 'format'] as const;
const MIRRORABLE_KEYWORDS = [...SUPPORTED_ARRAY_KEYWORDS, ...SUPPORTED_NUMBER_KEYWORDS, ...SUPPORTED_STRING_KEYWORDS];

/** Every string-length keyword must stay out of the model-facing schema. */
const UNSUPPORTED_KEYWORDS = ['maxLength', 'minLength'];

type JsonObject = Record<string, unknown>;
const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Walk a JSON-Schema tree, yielding [dottedPath, node] for every schema node. */
function* walk(node: unknown, path = '$'): Generator<[string, JsonObject]> {
  if (!isObject(node)) return;
  yield [path, node];
  const props = node.properties;
  if (isObject(props)) {
    for (const [key, child] of Object.entries(props)) yield* walk(child, `${path}.${key}`);
  }
  if (node.items !== undefined) yield* walk(node.items, `${path}[]`);
}

const handBuiltNodes = new Map(walk(DECISION_MAKER_JSON_SCHEMA));
// zod v4's own JSON-Schema projection is used ONLY as the source of truth for what Zod declares.
// It is never sent to OpenAI: it emits maxLength for every string .max(), which is exactly the
// unsupported-keyword class this contract exists to keep out.
const zodProjectedNodes = new Map(walk(z.toJSONSchema(decisionMakerExtractionOutputSchema) as JsonObject));

describe('decision-maker schema contract (Zod <-> model-facing JSON Schema)', () => {
  it('candidateRef no longer exists anywhere in the extraction contract', () => {
    expect(JSON.stringify(DECISION_MAKER_JSON_SCHEMA)).not.toContain('candidateRef');
    expect(Object.keys(decisionMakerExtractionOutputSchema.shape.candidates.element.shape)).not.toContain('candidateRef');

    // The prompt never described it either — that mismatch is what made it unanswerable for the model.
    const { system, user } = buildExtractorMessages([{ role: 'home', url: 'https://example.com/', text: 'Example.' }]);
    expect(`${system}\n${user}`).not.toContain('candidateRef');
  });

  it('a candidate object parses without candidateRef and rejects it as an unknown property', () => {
    const candidate = { fullName: 'A B', title: 'Owner', evidenceIds: ['E1'], confidence: 0.9, evidenceSnippet: 'A B, Owner.' };
    expect(decisionMakerExtractionOutputSchema.safeParse({ candidates: [candidate], insufficientEvidence: false }).success).toBe(true);

    const required = (handBuiltNodes.get('$.candidates[]')?.required ?? []) as string[];
    expect(required).toEqual(['fullName', 'title', 'evidenceIds', 'confidence', 'evidenceSnippet']);
  });

  it('mirrors candidates maxItems into the model-facing schema', () => {
    expect(handBuiltNodes.get('$.candidates')).toMatchObject({ type: 'array', maxItems: MAX_CANDIDATES });
  });

  it('mirrors evidenceIds minItems/maxItems into the model-facing schema', () => {
    expect(handBuiltNodes.get('$.candidates[].evidenceIds')).toMatchObject({
      type: 'array',
      minItems: MIN_EVIDENCE_IDS,
      maxItems: MAX_EVIDENCE_IDS,
    });
  });

  it('mirrors confidence minimum/maximum into the model-facing schema', () => {
    expect(handBuiltNodes.get('$.candidates[].confidence')).toMatchObject({ type: 'number', minimum: 0, maximum: 1 });
  });

  it('DRIFT GUARD: every supported constraint Zod declares is present and equal in the model-facing schema', () => {
    const drift: string[] = [];
    for (const [path, zodNode] of zodProjectedNodes) {
      const handBuilt = handBuiltNodes.get(path);
      if (!handBuilt) {
        drift.push(`${path}: present in Zod, missing from DECISION_MAKER_JSON_SCHEMA`);
        continue;
      }
      for (const keyword of MIRRORABLE_KEYWORDS) {
        if (!(keyword in zodNode)) continue;
        if (handBuilt[keyword] !== zodNode[keyword]) {
          drift.push(`${path}.${keyword}: Zod says ${JSON.stringify(zodNode[keyword])}, model-facing schema says ${JSON.stringify(handBuilt[keyword])}`);
        }
      }
    }
    expect(drift).toEqual([]);
  });

  it('DRIFT GUARD: the model-facing schema emits no unsupported keyword', () => {
    const offenders: string[] = [];
    for (const [path, node] of handBuiltNodes) {
      for (const keyword of UNSUPPORTED_KEYWORDS) {
        if (keyword in node) offenders.push(`${path}.${keyword}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps every object strict: additionalProperties false and all properties required', () => {
    for (const [path, node] of handBuiltNodes) {
      if (node.type !== 'object') continue;
      expect(node.additionalProperties, `${path}.additionalProperties`).toBe(false);
      expect([...(node.required as string[])].sort(), `${path}.required`).toEqual(Object.keys(node.properties as JsonObject).sort());
    }
  });

  it('schema version records the contract change', () => {
    expect(DECISION_MAKER_SCHEMA_VERSION).toBe('decision-maker-schema-2');
  });
});
