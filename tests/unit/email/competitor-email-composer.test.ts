import { describe, expect, it } from 'vitest';
import { composeEnrichedEmail } from '../../../src/domain/email/competitor-email-composer.js';
import { planEnrichment, type EnrichmentPackage, type EnrichmentPattern, type EnrichmentProspectFinding } from '../../../src/domain/email/competitor-enrichment.js';
import { type EmailWriterParsed } from '../../../src/domain/email/email-schema.js';
import { type EmailValidationContext } from '../../../src/domain/email/email-validation.js';
import { type EmailInputs } from '../../../src/domain/email/email-render.js';

function pattern(over: Partial<EnrichmentPattern> = {}): EnrichmentPattern {
  return {
    patternId: 'p-book', category: 'BOOKING_CTA_VISIBLE', result: 'ALL_OBSERVED', presentCount: 2,
    usableDenominator: 2, confidence: 'HIGH', wordingForm: 'TWO_OF_TWO', wordingText: 'two nearby clinics',
    consequenceLabel: 'BOOKING_DISCOVERABILITY', isDepth: false, evidenceItemIds: ['e1', 'e2'], ...over,
  };
}
function pkg(over: Partial<EnrichmentPackage> = {}): EnrichmentPackage {
  return { packageId: 'pkg1', version: 1, packageHash: 'hash-a', status: 'APPROVED', leadId: 'lead1', patterns: [pattern()], contrasts: [], identityTokens: ['smilecare'], ...over };
}
const findings: EnrichmentProspectFinding[] = [{ evidenceId: 'f1', findingRef: 'F1', category: 'BOOKING_FRICTION' }];

function draft(over: Partial<EmailWriterParsed> = {}): EmailWriterParsed {
  return {
    subject_options: ['Booking below the fold', 'Your booking placement', 'One tap to book'],
    selected_subject: 'Booking below the fold',
    selected_subject_reason: 'specific to the observed placement',
    email_body: 'Your booking action sits below the fold on mobile.\n\nRaising it would let visitors book in one step.',
    evidence_ids: ['f1'],
    strategic_angle: 'placement',
    business_relevance: 'the booking path',
    urgency_basis: 'observed friction',
    competitor_evidence_used: 'NONE',
    primary_cta: 'REPLY_FOR_DETAILS',
    prohibited_phrase_scan: 'PASS',
    punctuation_scan: 'PASS',
    genericity_score: 10,
    human_style_result: 'PASS',
    demo_alignment_result: 'NOT_APPLICABLE',
    ...over,
  };
}

const validationCtx: EmailValidationContext = {
  availableEvidenceIds: new Set(['f1']),
  factEvidenceIds: new Set(),
  acceptedFindingIds: new Set(['f1']),
  approvedDemoFindingIds: new Set(),
  demoLinkAllowed: false,
  language: 'en',
};
const emailInputs: EmailInputs = { facts: [], findings: [], demo: null };

function compose(over: { pkg?: EnrichmentPackage; d?: EmailWriterParsed } = {}) {
  const p = over.pkg ?? pkg();
  const outcome = planEnrichment({ leadId: 'lead1', language: 'en', package: p, safeFindings: findings, requestedPatternId: null });
  if (!outcome.ok) throw new Error(outcome.reason);
  return composeEnrichedEmail({ prospectDraft: over.d ?? draft(), emailInputs, validationCtx, plan: outcome.plan, pkg: p });
}

describe('composeEnrichedEmail — final artifact', () => {
  it('the FINAL artifact (not the raw model output) is schema-3 + APPROVED_COMPETITOR_PATTERN_PACKAGE', () => {
    const c = compose();
    expect(c.schemaVersion).toBe('email-copy-schema-3');
    expect(c.artifact.competitor_evidence_used).toBe('APPROVED_COMPETITOR_PATTERN_PACKAGE');
    expect(c.schemaOk).toBe(true);
    expect(c.ok).toBe(true);
  });

  it('passes the copy gate and the enriched-body validator', () => {
    const c = compose();
    expect(c.baseValidation.ok).toBe(true);
    expect(c.enrichedValidation.ok).toBe(true);
  });

  it('keeps the prospect observation before the competitor context', () => {
    const c = compose();
    const body = c.rendered.body;
    expect(body.indexOf('Your booking action')).toBeLessThan(body.indexOf('nearby clinics'));
  });

  it('adds no competitor language to the subject', () => {
    const c = compose();
    expect(c.rendered.subject).toBe('Booking below the fold');
    expect(c.rendered.subject.toLowerCase()).not.toContain('clinic');
  });

  it('contains exactly one competitor-pattern section', () => {
    const c = compose();
    expect(c.sections.filter((s) => s.kind === 'COMPETITOR_PATTERN')).toHaveLength(1);
  });

  it('preserves the exact stored count wording (two-of-three)', () => {
    const p = pkg({ patterns: [pattern({ presentCount: 2, usableDenominator: 3, wordingForm: 'TWO_OF_THREE', wordingText: 'two of three comparable nearby clinics' })] });
    const c = compose({ pkg: p });
    expect(c.rendered.body).toContain('three comparable nearby clinics');
    expect(c.ok).toBe(true);
  });

  it('the composed message hash changes when the package changes', () => {
    const a = compose({ pkg: pkg({ packageHash: 'hash-a' }) });
    const b = compose({ pkg: pkg({ packageHash: 'hash-b' }) });
    expect(a.composedMessageHash).not.toBe(b.composedMessageHash);
  });

  it('the composed message hash is stable for identical inputs', () => {
    expect(compose().composedMessageHash).toBe(compose().composedMessageHash);
  });

  it('emits a claim ledger of ONLY externally rendered claims (base has a recommendation → no consequence sentence)', () => {
    // The two-paragraph base carries an aligned observation AND recommendation, so the competitor section is
    // ONE sentence: the ledger holds no CAUTIOUS_CONSEQUENCE / PROSPECT_CONTRAST (Phase 7A4B2 §2).
    const kinds = compose().ledger.map((e) => e.claimType);
    expect(kinds).toContain('PROSPECT_OBSERVATION');
    expect(kinds).toContain('COMPETITOR_PATTERN');
    expect(kinds).toContain('RECOMMENDATION');
    expect(kinds).toContain('CTA');
    expect(kinds).not.toContain('CAUTIOUS_CONSEQUENCE');
    expect(kinds).not.toContain('PROSPECT_CONTRAST');
  });

  it('renders the cautious consequence only when the base LACKS an aligned recommendation (single-paragraph base)', () => {
    const c = compose({ d: draft({ email_body: 'Your booking action sits below the fold on mobile.' }) });
    const kinds = c.ledger.map((e) => e.claimType);
    expect(kinds).toContain('CAUTIOUS_CONSEQUENCE');
    expect(c.rendered.body).toContain('That may make booking harder for a first-time visitor to find.');
    expect(c.ok).toBe(true);
  });

  it('never leaks a competitor identity token into the body', () => {
    const c = compose({ pkg: pkg({ identityTokens: ['booking'] }) });
    // 'booking' appears in the prospect text, so this asserts the leak check is active and would fire.
    expect(c.enrichedValidation.violations.some((v) => v === 'competitor_identity_leak:booking')).toBe(true);
    expect(c.ok).toBe(false);
  });
});
