import { describe, expect, it } from 'vitest';
import {
  buildClaimLedger,
  buildCompositionSections,
  CONSEQUENCE_TEMPLATES,
  isEnrichablePattern,
  planEnrichment,
  renderEnrichedBody,
  validateEnrichedComposition,
  type EnrichmentPackage,
  type EnrichmentPattern,
  type EnrichmentPlan,
  type EnrichmentProspectFinding,
} from '../../../src/domain/email/competitor-enrichment.js';
import { emailWriterSchema, EMAIL_SCHEMA_VERSION } from '../../../src/domain/email/email-schema.js';

function pattern(over: Partial<EnrichmentPattern> = {}): EnrichmentPattern {
  return {
    patternId: 'p-book',
    category: 'BOOKING_CTA_VISIBLE',
    result: 'ALL_OBSERVED',
    presentCount: 2,
    usableDenominator: 2,
    confidence: 'HIGH',
    wordingForm: 'TWO_OF_TWO',
    wordingText: 'two nearby clinics',
    consequenceLabel: 'BOOKING_DISCOVERABILITY',
    isDepth: false,
    evidenceItemIds: ['e1', 'e2'],
    ...over,
  };
}

function pkg(over: Partial<EnrichmentPackage> = {}): EnrichmentPackage {
  return {
    packageId: 'pkg1',
    version: 1,
    packageHash: 'hash-a',
    status: 'APPROVED',
    leadId: 'lead1',
    patterns: [pattern()],
    contrasts: [],
    identityTokens: ['smilecare', 'mitte'],
    ...over,
  };
}

const bookingFinding: EnrichmentProspectFinding = { evidenceId: 'f1', findingRef: 'F1', category: 'BOOKING_FRICTION' };

function planOk(over: { pkg?: EnrichmentPackage; findings?: EnrichmentProspectFinding[]; language?: string; requestedPatternId?: string } = {}): EnrichmentPlan {
  const outcome = planEnrichment({
    leadId: 'lead1',
    language: over.language ?? 'en',
    package: over.pkg ?? pkg(),
    safeFindings: over.findings ?? [bookingFinding],
    requestedPatternId: over.requestedPatternId ?? null,
  });
  if (!outcome.ok) throw new Error(`expected ok plan, got: ${outcome.reason}`);
  return outcome.plan;
}

describe('isEnrichablePattern', () => {
  it('accepts a positive, HIGH, count-consistent booking pattern with wording + consequence', () => {
    expect(isEnrichablePattern(pattern())).toBe(true);
  });
  it('rejects a depth pattern', () => {
    expect(isEnrichablePattern(pattern({ category: 'MOBILE_NAVIGATION_DEPTH', isDepth: true }))).toBe(false);
  });
  it('rejects a sample-of-one (denominator/present < 2)', () => {
    expect(isEnrichablePattern(pattern({ presentCount: 1, usableDenominator: 1, wordingForm: 'NONE', wordingText: null }))).toBe(false);
  });
  it('rejects a count/wording mismatch (form inconsistent with counts)', () => {
    expect(isEnrichablePattern(pattern({ presentCount: 2, usableDenominator: 3, wordingForm: 'TWO_OF_TWO' }))).toBe(false);
  });
  it('rejects LOW confidence', () => {
    expect(isEnrichablePattern(pattern({ confidence: 'LOW' }))).toBe(false);
  });
  it('rejects a pattern without a consequence label (unmapped category)', () => {
    expect(isEnrichablePattern(pattern({ category: 'SERVICE_INFORMATION_VISIBLE', consequenceLabel: null }))).toBe(false);
  });
});

describe('planEnrichment — gates + fail-closed', () => {
  it('produces an aligned plan for a booking issue', () => {
    const plan = planOk();
    expect(plan.selection.pattern.category).toBe('BOOKING_CTA_VISIBLE');
    expect(plan.selection.alignment).toEqual({ auditCategory: 'BOOKING_FRICTION', evidenceCategory: 'BOOKING_CTA_VISIBLE' });
    expect(plan.competitorSentence).toContain('nearby clinics');
    expect(plan.consequenceSentence).toBe(CONSEQUENCE_TEMPLATES.BOOKING_DISCOVERABILITY);
  });

  for (const status of ['DRAFT', 'REVIEWED', 'REJECTED', 'SUPERSEDED', 'INVALIDATED'] as const) {
    it(`fails closed on ${status} package`, () => {
      const outcome = planEnrichment({ leadId: 'lead1', language: 'en', package: pkg({ status }), safeFindings: [bookingFinding], requestedPatternId: null });
      expect(outcome.ok).toBe(false);
    });
  }

  it('fails closed when the package belongs to another lead', () => {
    const outcome = planEnrichment({ leadId: 'other', language: 'en', package: pkg(), safeFindings: [bookingFinding], requestedPatternId: null });
    expect(outcome).toEqual({ ok: false, reason: 'package belongs to a different lead' });
  });

  it('fails closed for a non-English lead (English-only wording in 7A3B)', () => {
    const outcome = planEnrichment({ leadId: 'lead1', language: 'de', package: pkg(), safeFindings: [bookingFinding], requestedPatternId: null });
    expect(outcome.ok).toBe(false);
  });

  it('fails closed when no verified prospect issue aligns to any pattern', () => {
    const outcome = planEnrichment({ leadId: 'lead1', language: 'en', package: pkg(), safeFindings: [{ evidenceId: 'f2', findingRef: 'F2', category: 'NAVIGATION' }], requestedPatternId: null });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain('no materially relevant enrichment');
  });

  it('fails closed when the package has no enrichable pattern', () => {
    const outcome = planEnrichment({ leadId: 'lead1', language: 'en', package: pkg({ patterns: [pattern({ confidence: 'LOW' })] }), safeFindings: [bookingFinding], requestedPatternId: null });
    expect(outcome.ok).toBe(false);
  });
});

describe('planEnrichment — explicit --competitor-pattern selector', () => {
  it('honors a valid explicit pattern that aligns', () => {
    const plan = planOk({ requestedPatternId: 'p-book' });
    expect(plan.selection.pattern.patternId).toBe('p-book');
    expect(plan.selection.selectionReasons).toContain('explicit_operator_selection');
  });
  it('fails closed for a pattern id not in the package', () => {
    const outcome = planEnrichment({ leadId: 'lead1', language: 'en', package: pkg(), safeFindings: [bookingFinding], requestedPatternId: 'nope' });
    expect(outcome.ok).toBe(false);
  });
  it('fails closed for an explicit pattern that does not align with the primary issue', () => {
    const p2 = pattern({ patternId: 'p-phone', category: 'PHONE_VISIBLE', consequenceLabel: 'CONTACT_DISCOVERABILITY' });
    const outcome = planEnrichment({ leadId: 'lead1', language: 'en', package: pkg({ patterns: [pattern(), p2] }), safeFindings: [bookingFinding], requestedPatternId: 'p-phone' });
    expect(outcome.ok).toBe(false);
  });
});

describe('planEnrichment — deterministic selection order', () => {
  it('prefers a pattern with a prospect contrast tied to the primary issue', () => {
    const contrasted = pattern({ patternId: 'p-book-2', category: 'BOOKING_CTA_VISIBLE' });
    const plan = planOk({
      pkg: pkg({
        patterns: [pattern({ patternId: 'p-book-1' }), contrasted],
        contrasts: [{ contrastId: 'c1', category: 'BOOKING_CTA_VISIBLE', consequenceLabel: 'BOOKING_DISCOVERABILITY', prospectEvidenceRef: 'cap1', confidence: 'HIGH' }],
      }),
    });
    expect(plan.selection.selectionReasons[0]).toBe('has_prospect_contrast_for_primary_issue');
    expect(plan.selection.contrast?.contrastId).toBe('c1');
  });

  it('prefers HIGH over MEDIUM, ALL_OBSERVED over MAJORITY, then larger denominator', () => {
    const weak = pattern({ patternId: 'p-weak', confidence: 'MEDIUM', result: 'MAJORITY_OBSERVED', presentCount: 2, usableDenominator: 3, wordingForm: 'TWO_OF_THREE', wordingText: 'two of three comparable nearby clinics' });
    const strong = pattern({ patternId: 'p-strong', confidence: 'HIGH', result: 'ALL_OBSERVED', presentCount: 2, usableDenominator: 2, wordingForm: 'TWO_OF_TWO' });
    const plan = planOk({ pkg: pkg({ patterns: [weak, strong] }) });
    expect(plan.selection.pattern.patternId).toBe('p-strong');
  });
});

describe('composition + ledger', () => {
  it('places the prospect observation first and inserts exactly one competitor section', () => {
    const plan = planOk();
    const sections = buildCompositionSections(plan, ['Your booking sits below the fold.', 'Raising it would help.']);
    expect(sections[0]!.kind).toBe('PROSPECT_OBSERVATION');
    expect(sections.filter((s) => s.kind === 'COMPETITOR_PATTERN')).toHaveLength(1);
    const compIdx = sections.findIndex((s) => s.kind === 'COMPETITOR_PATTERN');
    expect(compIdx).toBeGreaterThan(0);
    const body = renderEnrichedBody(sections);
    expect(body.indexOf('Your booking')).toBeLessThan(body.indexOf('nearby clinics'));
  });

  it('builds a claim ledger with pattern provenance for the competitor claim', () => {
    const plan = planOk();
    const sections = buildCompositionSections(plan, ['Your booking sits below the fold.', 'Raising it would help.']);
    const ledger = buildClaimLedger(plan, sections, pkg());
    const comp = ledger.find((e) => e.claimType === 'COMPETITOR_PATTERN')!;
    expect(comp.patternId).toBe('p-book');
    expect(comp.competitorEvidenceIds).toEqual(['e1', 'e2']);
    expect(ledger.find((e) => e.claimType === 'PROSPECT_OBSERVATION')!.prospectEvidenceIds).toEqual(['f1']);
  });
});

describe('validateEnrichedComposition — hard fails', () => {
  const plan = planOk();
  const sections = buildCompositionSections(plan, ['Your booking sits below the fold.', 'Raising it would help.']);
  const ledger = buildClaimLedger(plan, sections, pkg());
  const goodBody = `Hello,\n\n${renderEnrichedBody(sections)}\n\nIf this is relevant, reply.\n\nBest regards,`;

  it('accepts a supported, anonymized, traceable body', () => {
    expect(validateEnrichedComposition(goodBody, plan, pkg(), ledger).ok).toBe(true);
  });
  it('blocks competitor identity leakage', () => {
    const leaked = `${goodBody}\nSmilecare is nearby.`;
    const res = validateEnrichedComposition(leaked, plan, pkg(), ledger);
    expect(res.ok).toBe(false);
    expect(res.violations.some((v) => v.startsWith('competitor_identity_leak'))).toBe(true);
  });
  for (const term of ['convert better', 'more bookings', 'ranks higher', 'more customers']) {
    it(`blocks a prohibited claim: "${term}"`, () => {
      const res = validateEnrichedComposition(`${goodBody}\nThey ${term}.`, plan, pkg(), ledger);
      expect(res.ok).toBe(false);
      expect(res.violations.some((v) => v.startsWith('prohibited_claim'))).toBe(true);
    });
  }
  it('blocks a missing competitor sentence', () => {
    expect(validateEnrichedComposition('Hello,\n\nJust prospect text.', plan, pkg(), ledger).ok).toBe(false);
  });
  it('blocks an altered (non-template) consequence sentence when the consequence is rendered', () => {
    // A single-paragraph base lacks an aligned recommendation, so the cautious consequence IS rendered and
    // therefore validated against the fixed template table.
    const singleSections = buildCompositionSections(plan, ['Your booking sits below the fold.']);
    const singleLedger = buildClaimLedger(plan, singleSections, pkg());
    const altered: EnrichmentPlan = { ...plan, consequenceSentence: 'That is simply a different layout choice.' };
    const alteredSections = buildCompositionSections(altered, ['Your booking sits below the fold.']);
    const alteredBody = `Hello,\n\n${renderEnrichedBody(alteredSections)}\n\nIf this is relevant, reply.\n\nBest regards,`;
    expect(singleLedger.some((e) => e.claimType === 'CAUTIOUS_CONSEQUENCE')).toBe(true);
    const res = validateEnrichedComposition(alteredBody, altered, pkg(), buildClaimLedger(altered, alteredSections, pkg()));
    expect(res.ok).toBe(false);
    expect(res.violations).toContain('consequence_not_from_template');
  });
  it('blocks missing comparative traceability', () => {
    const stripped = ledger.map((e) => (e.claimType === 'COMPETITOR_PATTERN' ? { ...e, patternId: null } : e));
    const res = validateEnrichedComposition(goodBody, plan, pkg(), stripped);
    expect(res.ok).toBe(false);
    expect(res.violations.some((v) => v.startsWith('comparative_missing_pattern_ref'))).toBe(true);
  });
});

describe('email schema — competitor_evidence_used widening', () => {
  const base = {
    subject_options: ['Booking below the fold', 'Your booking placement', 'One tap to book'],
    selected_subject: 'Booking below the fold',
    selected_subject_reason: 'specific to the observed placement',
    email_body: 'Your booking sits below the fold.\n\nRaising it would help visitors.',
    evidence_ids: ['f1'],
    strategic_angle: 'placement',
    business_relevance: 'booking path',
    urgency_basis: 'observed friction',
    primary_cta: 'REPLY_FOR_DETAILS',
    prohibited_phrase_scan: 'PASS',
    punctuation_scan: 'PASS',
    genericity_score: 10,
    human_style_result: 'PASS',
    demo_alignment_result: 'NOT_APPLICABLE',
  };
  it('bumped to email-copy-schema-3', () => {
    expect(EMAIL_SCHEMA_VERSION).toBe('email-copy-schema-3');
  });
  it('accepts NONE (prospect-only)', () => {
    expect(emailWriterSchema.safeParse({ ...base, competitor_evidence_used: 'NONE' }).success).toBe(true);
  });
  it('accepts APPROVED_COMPETITOR_PATTERN_PACKAGE', () => {
    expect(emailWriterSchema.safeParse({ ...base, competitor_evidence_used: 'APPROVED_COMPETITOR_PATTERN_PACKAGE' }).success).toBe(true);
  });
  it('rejects any other value', () => {
    expect(emailWriterSchema.safeParse({ ...base, competitor_evidence_used: 'NAMED' }).success).toBe(false);
  });
});
