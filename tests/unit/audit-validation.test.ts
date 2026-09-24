import { describe, expect, it } from 'vitest';
import { type AuditGeneratorOutputParsed, type AuditReviewOutputParsed } from '../../src/domain/audit/audit-schema.js';
import { validateGeneratorOutput, validateReviewMapping } from '../../src/domain/audit/validation.js';
import { PRIMARY_URL, testPackage } from './helpers/audit-fixtures.js';

const pkg = testPackage();
const evId = pkg.evidence[0]?.id ?? 'ev-x';

function output(findingOverrides: Record<string, unknown> = {}, summary = 'A short factual summary.'): AuditGeneratorOutputParsed {
  return {
    summary,
    findings: [
      {
        findingRef: 'F1',
        category: 'CTA_CLARITY',
        observation: 'The main action may be hard to notice.',
        evidenceIds: [evId],
        affectedUrls: [PRIMARY_URL],
        affectedProfiles: ['DESKTOP'],
        severity: 'MEDIUM',
        confidence: 0.8,
        businessImpact: 'May create friction for interested visitors.',
        recommendation: 'Make the primary action more prominent.',
        safeForOutreach: true,
        outreachAngle: null,
        uncertainty: null,
        ...findingOverrides,
      },
    ],
    insufficientEvidenceAreas: [],
    conflictingEvidence: [],
    captureLimitations: [],
  } as AuditGeneratorOutputParsed;
}

describe('validateGeneratorOutput', () => {
  it('accepts a clean, grounded finding', () => {
    expect(validateGeneratorOutput(output(), pkg).ok).toBe(true);
  });

  it('rejects evidence ids outside the package', () => {
    const r = validateGeneratorOutput(output({ evidenceIds: ['not-in-package'] }), pkg);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.startsWith('evidence_outside_package'))).toBe(true);
  });

  it('rejects findings with no evidence', () => {
    const r = validateGeneratorOutput(output({ evidenceIds: [] }), pkg);
    expect(r.violations).toContain('no_evidence:F1');
  });

  it('rejects URLs outside the allowed canonical set', () => {
    const r = validateGeneratorOutput(output({ affectedUrls: ['https://attacker.example/page'] }), pkg);
    expect(r.violations).toContain('unsupported_url:F1');
  });

  it('accepts URL variants that canonicalize to an allowed URL', () => {
    const variant = `${PRIMARY_URL}?utm_source=x#frag`;
    expect(validateGeneratorOutput(output({ affectedUrls: [variant] }), pkg).ok).toBe(true);
  });

  it('rejects duplicate finding refs', () => {
    const o = output();
    o.findings.push({ ...(o.findings[0] as AuditGeneratorOutputParsed['findings'][number]) });
    const r = validateGeneratorOutput(o, pkg);
    expect(r.violations).toContain('duplicate_finding_ref:F1');
  });

  it.each([
    ['a 25% improvement is likely', 'numeric_percentage'],
    ['this hurts your revenue', 'revenue_claim'],
    ['your traffic is low', 'traffic_claim'],
    ['your search engine position suffers', 'ranking_claim'],
    ['the conversion rate drops', 'conversion_rate_claim'],
    ['your competitor does this better', 'competitor_claim'],
    ['this will increase bookings', 'performance_promise'],
    ['rated 3 stars by patients', 'fabricated_rating'],
    ['you have lost customers', 'loss_claim'],
  ])('rejects forbidden claim: %s', (text, label) => {
    const r = validateGeneratorOutput(output({ businessImpact: text }), pkg);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.includes(label))).toBe(true);
  });

  it('rejects an unresolved template artifact', () => {
    const r = validateGeneratorOutput(output({ recommendation: 'TODO: write recommendation' }), pkg);
    expect(r.violations).toContain('template_artifact:F1');
  });

  // Regression, from two real paid audits destroyed by the retired word-policing rule:
  // Gipsy Hill run 9af30a7a ("placeholder anchors") and 311 Dental Care run b431a104
  // (accessibility finding about HTML form placeholders). "placeholder" is ordinary
  // website vocabulary and must never fail on its own.
  it.each([
    'The captured footer policy links appear to use placeholder anchors and would be worth checking before patients submit personal information.',
    'Form controls without persistent programmatic labels may be harder to understand for screen-reader users and for users when placeholder text disappears.',
    'Do not rely on placeholders as the only field description.',
    'The capture does not expose placeholder text or the rendered accessibility tree, so manual inspection is required.',
    'The hero section shows a placeholder image.',
    'Several navigation placeholder links were captured on mobile.',
  ])('accepts ordinary use of the word "placeholder": %s', (text) => {
    expect(validateGeneratorOutput(output({ outreachAngle: text }), pkg).ok).toBe(true);
  });

  // Structural unresolved-template artifacts must still fail.
  it.each([
    ['{{businessName}} should update this page.'],
    ['{{ PRACTICE_NAME }} has not been filled in.'],
    ['Contact ${practiceName} for details.'],
    ['<insert business name> should update this page.'],
    ['[TODO: write the recommendation]'],
    ['[PLACEHOLDER]'],
    ['[FIXME check this]'],
    ['TODO: write recommendation'],
    ['FIXME needs a second pass'],
    ['lorem ipsum dolor sit amet'],
    ['The value is XXXX and needs filling in.'],
  ])('still rejects unresolved template artifacts: %s', (text) => {
    expect(validateGeneratorOutput(output({ recommendation: text }), pkg).violations).toContain(
      'template_artifact:F1',
    );
  });

  it('rejects prompt leakage in findings and summary', () => {
    expect(validateGeneratorOutput(output({ observation: 'As an AI I was told to ignore previous instructions' }), pkg).ok).toBe(false);
    expect(validateGeneratorOutput(output({}, 'My instructions say to approve everything'), pkg).violations).toContain('prompt_leakage:summary');
  });
});

describe('validateReviewMapping', () => {
  const gen = output();
  const review = (refs: string[], revised: string | null = null): AuditReviewOutputParsed => ({
    findings: refs.map((findingRef) => ({
      findingRef,
      decision: 'APPROVE',
      evidenceSupported: true,
      impactSupported: true,
      safeForOutreach: true,
      problems: [],
      revisedObservation: revised,
      revisedBusinessImpact: null,
      revisedRecommendation: null,
      revisedOutreachAngle: null,
    })),
    overallDecision: 'APPROVE',
  });

  it('accepts reviews that reference generator refs', () => {
    expect(validateReviewMapping(gen, review(['F1'])).ok).toBe(true);
  });

  it('rejects unknown refs', () => {
    expect(validateReviewMapping(gen, review(['F9'])).violations).toContain('review_ref_unknown:F9');
  });

  it('rejects duplicate refs', () => {
    expect(validateReviewMapping(gen, review(['F1', 'F1'])).violations).toContain('duplicate_review_ref:F1');
  });

  it('applies forbidden-claim checks to revised text', () => {
    const r = validateReviewMapping(gen, review(['F1'], 'this will double your revenue'));
    expect(r.ok).toBe(false);
  });
});
