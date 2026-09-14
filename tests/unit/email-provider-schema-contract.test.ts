import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  EMAIL_REVIEW_JSON_SCHEMA,
  EMAIL_SCHEMA_VERSION,
  EMAIL_WRITER_JSON_SCHEMA,
  emailReviewSchema,
  emailWriterSchema,
  providerJsonSchema,
} from '../../src/domain/email/email-schema.js';
import {
  DEMO_ALIGNMENT_RESULTS,
  EMAIL_COMPETITOR_EVIDENCE_MODES,
  MAX_SUBJECT_LENGTH,
  PRIMARY_CTAS,
  REVIEW_DECISIONS,
  SCAN_RESULTS,
} from '../../src/domain/email/email-types.js';

/**
 * THE PROVIDER SCHEMA AND THE LOCAL SCHEMA ARE ONE CONTRACT.
 *
 * The provider schema constrains what the model may emit; the Zod schema decides what this process
 * accepts. Any constraint present in the second but missing from the first is a paid call that can
 * never succeed — which is exactly what happened in production: `problems` / `requiredRevisions`
 * shipped to the provider as a bare `{ type: 'array', items: { type: 'string' } }` while Zod
 * required at most 20 entries of 1-300 characters, so a schema-valid reviewer response was rejected
 * locally as SCHEMA_INVALID after the money was spent.
 *
 * These tests assert the shipped wire schema by VALUE (not by re-deriving it, which would be
 * circular) and then check that nothing in Zod is left unrepresented.
 */

/** The subset of JSON Schema these two contracts use. */
interface JsonSchema {
  type?: string;
  enum?: readonly unknown[];
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
}

const writer = EMAIL_WRITER_JSON_SCHEMA as JsonSchema;
const review = EMAIL_REVIEW_JSON_SCHEMA as JsonSchema;

const prop = (schema: JsonSchema, name: string): JsonSchema => {
  const p = schema.properties?.[name];
  expect(p, `${name} is missing from the provider schema`).toBeDefined();
  return p!;
};

describe('reviewer provider schema — the constraints the production failure needed', () => {
  it.each(['problems', 'requiredRevisions'])('%s bounds the array at 20 entries', (field) => {
    expect(prop(review, field)).toMatchObject({ type: 'array', maxItems: 20 });
  });

  it.each(['problems', 'requiredRevisions'])('%s bounds each entry to 1-300 characters', (field) => {
    expect(prop(review, field).items).toMatchObject({ type: 'string', minLength: 1, maxLength: 300 });
  });

  it('would reject the shape that slipped through before: 21 entries', () => {
    const payload = Array.from({ length: 21 }, (_, i) => `problem ${String(i)}`);
    // Local schema rejects it...
    expect(emailReviewSchema.safeParse({ ...validReview(), problems: payload }).success).toBe(false);
    // ...and the wire schema now declares the bound that stops the model emitting it.
    expect(payload.length).toBeGreaterThan(prop(review, 'problems').maxItems ?? Infinity);
  });

  it('would reject an over-long entry too', () => {
    const tooLong = 'x'.repeat(301);
    expect(emailReviewSchema.safeParse({ ...validReview(), problems: [tooLong] }).success).toBe(false);
    expect(tooLong.length).toBeGreaterThan(prop(review, 'problems').items?.maxLength ?? Infinity);
  });

  it('pins the decision enum', () => {
    expect(prop(review, 'decision')).toMatchObject({ type: 'string', enum: [...REVIEW_DECISIONS] });
  });

  it('requires every boolean dimension, with no extra keys allowed', () => {
    expect(review.additionalProperties).toBe(false);
    for (const boolean of [
      'fabricationRisk', 'subjectSpecific', 'subjectCuriosityGap', 'openingSpecific',
      'businessRelevanceClear', 'urgencySupported', 'competitorClaimsSupported', 'humanStylePass',
      'punctuationPass', 'singlePrimaryCta', 'sufficientlyPersonalized', 'evidenceSupported',
      'demoAligned', 'persuasive', 'singleObservation', 'buyerLanguageOnly', 'conversationNotAudit',
      'confidentObservation', 'addsClarityNotRestart', 'compressedNotExpanded', 'pressureReduced',
      'binaryReplyClose',
    ]) {
      expect(prop(review, boolean)).toMatchObject({ type: 'boolean' });
      expect(review.required).toContain(boolean);
    }
  });
});

describe('writer provider schema — every representable limit is on the wire', () => {
  it('bounds the three subject options and their length', () => {
    expect(prop(writer, 'subject_options')).toMatchObject({ type: 'array', minItems: 3, maxItems: 3 });
    expect(prop(writer, 'subject_options').items).toMatchObject({ type: 'string', minLength: 1, maxLength: MAX_SUBJECT_LENGTH });
  });

  it.each([
    ['selected_subject', 1, MAX_SUBJECT_LENGTH],
    ['selected_subject_reason', 1, 400],
    ['email_body', 1, 2000],
    ['strategic_angle', 1, 400],
    ['business_relevance', 1, 500],
    ['urgency_basis', 1, 400],
  ])('%s is bounded to %i-%i characters', (field, min, max) => {
    expect(prop(writer, field)).toMatchObject({ type: 'string', minLength: min, maxLength: max });
  });

  it('bounds the evidence-id array and each id', () => {
    expect(prop(writer, 'evidence_ids')).toMatchObject({ type: 'array', minItems: 1, maxItems: 12 });
    expect(prop(writer, 'evidence_ids').items).toMatchObject({ type: 'string', minLength: 1, maxLength: 128 });
  });

  it('keeps the numeric and enum limits', () => {
    expect(prop(writer, 'genericity_score')).toMatchObject({ type: 'integer', minimum: 0, maximum: 100 });
    expect(prop(writer, 'competitor_evidence_used')).toMatchObject({ enum: [...EMAIL_COMPETITOR_EVIDENCE_MODES] });
    expect(prop(writer, 'primary_cta')).toMatchObject({ enum: [...PRIMARY_CTAS] });
    expect(prop(writer, 'prohibited_phrase_scan')).toMatchObject({ enum: [...SCAN_RESULTS] });
    expect(prop(writer, 'punctuation_scan')).toMatchObject({ enum: [...SCAN_RESULTS] });
    expect(prop(writer, 'human_style_result')).toMatchObject({ enum: [...SCAN_RESULTS] });
    expect(prop(writer, 'demo_alignment_result')).toMatchObject({ enum: [...DEMO_ALIGNMENT_RESULTS] });
  });

  it('refuses extra keys and requires every field', () => {
    expect(writer.additionalProperties).toBe(false);
    expect([...(writer.required ?? [])].sort()).toEqual(Object.keys(writer.properties ?? {}).sort());
  });
});

/**
 * The completeness half: whatever Zod expresses, the wire schema must carry. Derived from the Zod
 * schema itself, so a field or limit added to Zod later cannot quietly ship without its provider
 * counterpart.
 */
describe('no drift: every representable Zod constraint reaches the provider', () => {
  const KEYWORDS = ['type', 'enum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minimum', 'maximum'] as const;

  const derive = (schema: z.ZodType): JsonSchema =>
    z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema;

  const compare = (name: string, zodSchema: z.ZodType, shipped: JsonSchema): void => {
    const expected = derive(zodSchema);
    const expectedProps = expected.properties ?? {};
    const shippedProps = shipped.properties ?? {};

    expect(Object.keys(shippedProps).sort(), `${name}: field set`).toEqual(Object.keys(expectedProps).sort());
    expect([...(shipped.required ?? [])].sort(), `${name}: required`).toEqual([...(expected.required ?? [])].sort());

    for (const [field, want] of Object.entries(expectedProps)) {
      const got = shippedProps[field]!;
      for (const keyword of KEYWORDS) {
        if (want[keyword] === undefined) continue;
        expect(got[keyword], `${name}.${field}.${keyword}`).toEqual(want[keyword]);
      }
      const wantItems = want.items;
      if (wantItems) {
        for (const keyword of KEYWORDS) {
          if (wantItems[keyword] === undefined) continue;
          expect(got.items?.[keyword], `${name}.${field}.items.${keyword}`).toEqual(wantItems[keyword]);
        }
      }
    }
  };

  it('writer', () => { compare('writer', emailWriterSchema, writer); });
  it('reviewer', () => { compare('reviewer', emailReviewSchema, review); });

  it('documents the ONE difference JSON Schema cannot express', () => {
    // Zod trims BEFORE measuring, so a whitespace-only string satisfies `minLength: 1` on the wire
    // and still fails locally. That residue is why a schema-invalid reviewer response must stay
    // durably auditable rather than merely being retried.
    expect(emailReviewSchema.safeParse({ ...validReview(), problems: ['   '] }).success).toBe(false);
    expect(prop(review, 'problems').items?.minLength).toBe(1);
  });
});

describe('the derivation is fail-closed: nothing reaches the provider unconstrained', () => {
  it('refuses a construct JSON Schema cannot represent, instead of emitting a permissive field', () => {
    // With Zod's permissive mode this becomes `{}` — a field with no constraints whatsoever, which
    // is precisely the drift the derivation exists to prevent. Strict mode throws instead.
    const custom = z.object({ a: z.custom<string>(() => true) });
    expect(() => providerJsonSchema(custom, 'test')).toThrow(/cannot be represented/i);
  });

  it.each([['any', z.any()], ['unknown', z.unknown()]] as const)(
    'refuses a %s field, which converts to an unconstrained schema without throwing',
    (_label, member) => {
      // Zod converts these silently; the backstop is what stops them reaching the wire.
      expect(() => providerJsonSchema(z.object({ a: member }), 'test')).toThrow(/unconstrained/i);
    },
  );

  it('refuses an optional field, which structured outputs cannot express', () => {
    const optional = z.object({ a: z.string(), b: z.string().optional() });
    expect(() => providerJsonSchema(optional, 'test')).toThrow(/require every field/i);
  });

  it('refuses an empty object', () => {
    expect(() => providerJsonSchema(z.object({}), 'test')).toThrow(/no properties/i);
  });

  it('accepts an ordinary representable schema and hardens it', () => {
    const derived = providerJsonSchema(z.object({ a: z.string().min(1).max(5) }), 'test');
    expect(derived).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['a'],
      properties: { a: { type: 'string', minLength: 1, maxLength: 5 } },
    });
    // The dialect marker is stripped: structured outputs has no use for it.
    expect(derived).not.toHaveProperty('$schema');
  });

  it('the shipped schemas carry no dialect marker either', () => {
    expect(writer).not.toHaveProperty('$schema');
    expect(review).not.toHaveProperty('$schema');
  });
});

describe('schema version', () => {
  it('names the CURRENT provider contract, not the permissive one it replaced', () => {
    // The wire contract changed materially (derived + fully constrained), so a model_call recorded
    // under it must be distinguishable from one made against the old hand-written schema.
    expect(EMAIL_SCHEMA_VERSION).toBe('email-copy-schema-5');
    expect(EMAIL_SCHEMA_VERSION).not.toBe('email-copy-schema-4');
  });
});

function validReview(): Record<string, unknown> {
  return {
    decision: 'APPROVE', fabricationRisk: false, subjectSpecific: true, subjectCuriosityGap: true,
    openingSpecific: true, businessRelevanceClear: true, urgencySupported: true,
    competitorClaimsSupported: true, humanStylePass: true, punctuationPass: true, singlePrimaryCta: true,
    sufficientlyPersonalized: true, evidenceSupported: true, demoAligned: true, persuasive: true,
    singleObservation: true, buyerLanguageOnly: true, conversationNotAudit: true, confidentObservation: true,
    addsClarityNotRestart: true, compressedNotExpanded: true, pressureReduced: true, binaryReplyClose: true,
    problems: [], requiredRevisions: [],
  };
}
