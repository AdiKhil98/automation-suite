import { describe, expect, it } from 'vitest';

import {
  auditGeneratorOutputSchema,
  GENERATOR_JSON_SCHEMA,
  LIMITS,
  normalizeGeneratorMetadata,
  REVIEWER_JSON_SCHEMA,
  truncateAtWordBoundary,
} from '../../src/domain/audit/audit-schema.js';

/** The exact conflictingEvidence string that failed audit run 33dca9fa (244 chars vs a 200 cap). */
const INCIDENT_244 =
  'The attached mobile screenshot depicts the homepage, while much of the supplied mobile navigation evidence is associated with https://dentistgipsyhill.co.uk/contact/. This prevents a reliable page-for-page desktop/mobile consistency comparison.';

function generatorOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: 'A short factual summary.',
    findings: [
      {
        findingRef: 'F1',
        category: 'CTA_CLARITY',
        observation: 'The main action may be hard to notice.',
        evidenceIds: ['ev-1'],
        affectedUrls: [],
        affectedProfiles: ['DESKTOP'],
        severity: 'MEDIUM',
        confidence: 0.8,
        businessImpact: 'May create friction for interested visitors.',
        recommendation: 'Make the primary action more prominent.',
        safeForOutreach: true,
        outreachAngle: null,
        uncertainty: null,
      },
    ],
    insufficientEvidenceAreas: [],
    conflictingEvidence: [],
    captureLimitations: [],
    ...overrides,
  };
}

describe('incident regression: schema_invalid:conflictingEvidence.0', () => {
  it('the incident string is genuinely over the limit', () => {
    expect(INCIDENT_244).toHaveLength(244);
    expect(INCIDENT_244.length).toBeGreaterThan(LIMITS.metadataItem);
  });

  it('rejected the whole audit before the fix', () => {
    const raw = generatorOutput({ conflictingEvidence: [INCIDENT_244] });
    expect(auditGeneratorOutputSchema.safeParse(raw).success).toBe(false);
  });

  it('now normalizes and validates, preserving the rest of the audit', () => {
    const raw = generatorOutput({ conflictingEvidence: [INCIDENT_244] });
    const parsed = auditGeneratorOutputSchema.safeParse(normalizeGeneratorMetadata(raw));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const item = parsed.data.conflictingEvidence[0]!;
    expect(item.length).toBeLessThanOrEqual(LIMITS.metadataItem);
    expect(item.startsWith('The attached mobile screenshot depicts the homepage')).toBe(true);
    expect(parsed.data.findings).toHaveLength(1); // findings untouched
    expect(parsed.data.findings[0]!.observation).toBe('The main action may be hard to notice.');
  });
});

describe('truncateAtWordBoundary', () => {
  it('leaves values within the limit exactly as-is', () => {
    expect(truncateAtWordBoundary('short text', 200)).toBe('short text');
    const exact = 'x'.repeat(200);
    expect(truncateAtWordBoundary(exact, 200)).toBe(exact);
  });

  it('never exceeds the limit and marks the cut', () => {
    const out = truncateAtWordBoundary(INCIDENT_244, LIMITS.metadataItem);
    expect(out.length).toBeLessThanOrEqual(LIMITS.metadataItem);
    expect(out.endsWith('…')).toBe(true);
  });

  it('breaks on a word boundary, not mid-word', () => {
    const out = truncateAtWordBoundary(INCIDENT_244, LIMITS.metadataItem);
    const body = out.slice(0, -1);
    expect(INCIDENT_244.startsWith(body)).toBe(true);
    // the character right after the kept body is a space (clean boundary)
    expect(INCIDENT_244.charAt(body.length)).toBe(' ');
  });

  it('strips dangling punctuation before the ellipsis', () => {
    const out = truncateAtWordBoundary(`${'word '.repeat(45)}tail, more words here`, 200);
    expect(out.endsWith(',…')).toBe(false);
  });

  it('hard-cuts when there is no sensible boundary', () => {
    const out = truncateAtWordBoundary('y'.repeat(400), 200);
    expect(out.length).toBe(200);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('normalizeGeneratorMetadata', () => {
  it.each(['insufficientEvidenceAreas', 'conflictingEvidence', 'captureLimitations'])(
    'clamps every item of %s',
    (field) => {
      const raw = generatorOutput({ [field]: [INCIDENT_244, 'fine', INCIDENT_244] });
      const parsed = auditGeneratorOutputSchema.safeParse(normalizeGeneratorMetadata(raw));
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      const arr = parsed.data[field as 'conflictingEvidence'];
      expect(arr).toHaveLength(3);
      expect(arr.every((v) => v.length <= LIMITS.metadataItem)).toBe(true);
      expect(arr[1]).toBe('fine');
    },
  );

  it('clamps an over-long summary', () => {
    const raw = generatorOutput({ summary: 'word '.repeat(400) });
    const parsed = auditGeneratorOutputSchema.safeParse(normalizeGeneratorMetadata(raw));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.summary.length).toBeLessThanOrEqual(LIMITS.summary);
  });

  it.each([
    ['observation', 'o'.repeat(LIMITS.observation + 1)],
    ['businessImpact', 'b'.repeat(LIMITS.businessImpact + 1)],
    ['recommendation', 'r'.repeat(LIMITS.recommendation + 1)],
    ['outreachAngle', 'a'.repeat(LIMITS.outreachAngle + 1)],
    ['uncertainty', 'u'.repeat(LIMITS.uncertainty + 1)],
  ])('does NOT silently truncate substantive finding field %s — it still fails loudly', (field, value) => {
    const base = generatorOutput();
    const findings = base.findings as Record<string, unknown>[];
    const raw = { ...base, findings: [{ ...findings[0], [field]: value }] };
    const parsed = auditGeneratorOutputSchema.safeParse(normalizeGeneratorMetadata(raw));
    expect(parsed.success).toBe(false);
  });

  it('passes non-object and malformed input through untouched', () => {
    expect(normalizeGeneratorMetadata(null)).toBeNull();
    expect(normalizeGeneratorMetadata('nope')).toBe('nope');
    expect(normalizeGeneratorMetadata([1, 2])).toEqual([1, 2]);
    expect(normalizeGeneratorMetadata({ conflictingEvidence: 'not-an-array' })).toEqual({
      conflictingEvidence: 'not-an-array',
    });
    expect(normalizeGeneratorMetadata({ conflictingEvidence: [42, null] })).toEqual({
      conflictingEvidence: [42, null],
    });
  });

  it('does not mutate the caller’s object', () => {
    const raw = generatorOutput({ conflictingEvidence: [INCIDENT_244] });
    normalizeGeneratorMetadata(raw);
    expect((raw.conflictingEvidence as string[])[0]).toHaveLength(244);
  });
});

describe('JSON schema mirrors the Zod limits', () => {
  const props = GENERATOR_JSON_SCHEMA.properties as Record<string, Record<string, unknown>>;
  const finding = (props.findings.items as Record<string, unknown>).properties as Record<
    string,
    Record<string, unknown>
  >;

  it('declares summary and metadata-array limits to the model', () => {
    expect(props.summary.maxLength).toBe(LIMITS.summary);
    for (const key of ['insufficientEvidenceAreas', 'conflictingEvidence', 'captureLimitations']) {
      expect((props[key].items as Record<string, unknown>).maxLength).toBe(LIMITS.metadataItem);
      expect(props[key].maxItems).toBe(20);
    }
  });

  it('declares finding field limits to the model', () => {
    expect(finding.observation.maxLength).toBe(LIMITS.observation);
    expect(finding.businessImpact.maxLength).toBe(LIMITS.businessImpact);
    expect(finding.recommendation.maxLength).toBe(LIMITS.recommendation);
    expect(finding.outreachAngle.maxLength).toBe(LIMITS.outreachAngle);
    expect(finding.uncertainty.maxLength).toBe(LIMITS.uncertainty);
    expect(finding.confidence.minimum).toBe(0);
    expect(finding.confidence.maximum).toBe(1);
  });

  it('declares reviewer field limits to the model', () => {
    const rprops = REVIEWER_JSON_SCHEMA.properties as Record<string, Record<string, unknown>>;
    const r = (rprops.findings.items as Record<string, unknown>).properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(r.revisedObservation.maxLength).toBe(LIMITS.observation);
    expect(r.revisedBusinessImpact.maxLength).toBe(LIMITS.businessImpact);
    expect(r.revisedRecommendation.maxLength).toBe(LIMITS.recommendation);
    expect(r.revisedOutreachAngle.maxLength).toBe(LIMITS.outreachAngle);
    expect((r.problems.items as Record<string, unknown>).maxLength).toBe(LIMITS.reviewProblem);
  });
});
