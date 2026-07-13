import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { QUALIFICATION_RULES } from '../../src/config/qualification-rules.js';
import { type FactType, type LeadFact } from '../../src/domain/lead-facts/lead-fact.js';
import { normalizeName } from '../../src/domain/leads/normalize.js';
import { evaluateQualification, type QualificationNiche } from '../../src/domain/qualification/qualify.js';

const NICHE: QualificationNiche = {
  allowedCategories: ['dentist', 'orthodontist'],
  excludeChains: true,
  chainNames: [],
};

const NOW = new Date('2026-07-11T00:00:00Z');

function mkFacts(spec: Partial<Record<FactType, string | number>>): LeadFact[] {
  return Object.entries(spec).map(([type, raw]) => {
    const value = String(raw);
    const normalizable = type === 'business_name' || type === 'category';
    return {
      id: randomUUID(),
      leadId: 'L1',
      factType: type as FactType,
      value,
      normalizedValue: normalizable ? normalizeName(value) : null,
      sourceType: 'mock',
      sourceUrl: null,
      capturedAt: NOW,
      confidence: 1,
      supersededBy: null,
      supersededAt: null,
      isCurrent: true,
    };
  });
}

function ctx(over: Partial<{ niche: QualificationNiche; suppressed: boolean }> = {}) {
  return {
    leadId: 'L1',
    campaign: 'test',
    niche: over.niche ?? NICHE,
    suppressed: over.suppressed ?? false,
    now: NOW,
  };
}

const STRONG = {
  business_name: 'Bright Smile Dental',
  business_status: 'OPERATIONAL',
  category: 'dentist',
  phone: '01614960001',
  rating: 4.7,
  review_count: 130,
  ownership_type: 'INDEPENDENT',
} as const;

describe('evaluateQualification (PRE_AUDIT)', () => {
  it('strong lead WITH official domain → ACCEPT / AUDIT / HIGH', () => {
    const r = evaluateQualification(
      mkFacts({ ...STRONG, official_domain: 'brightsmile.example' }),
      ctx(),
      QUALIFICATION_RULES,
    );
    expect(r.decision).toBe('ACCEPT');
    expect(r.nextStep).toBe('AUDIT');
    expect(r.priority).toBe('HIGH');
    expect(r.opportunityScore).toBeNull();
    expect(r.qualificationStage).toBe('PRE_AUDIT');
    expect(r.inputFactIds.length).toBeGreaterThan(0);
  });

  it('strong lead PHONE-ONLY (no domain) → ACCEPT / WEBSITE_DISCOVERY (never AUDIT)', () => {
    const r = evaluateQualification(mkFacts(STRONG), ctx(), QUALIFICATION_RULES);
    expect(r.decision).toBe('ACCEPT');
    expect(r.nextStep).toBe('WEBSITE_DISCOVERY');
    expect(r.auditabilityScore).toBe(0);
  });

  it('weak lead → REVIEW / MANUAL_REVIEW', () => {
    const r = evaluateQualification(
      mkFacts({
        business_name: 'Tiny Dental',
        business_status: 'OPERATIONAL',
        category: 'dentist',
        phone: '01610000000',
        rating: 3.0,
        review_count: 4,
        ownership_type: 'UNKNOWN',
      }),
      ctx(),
      QUALIFICATION_RULES,
    );
    expect(r.decision).toBe('REVIEW');
    expect(r.nextStep).toBe('MANUAL_REVIEW');
  });

  it('Google Place-ID-only candidate (no facts) → REVIEW / NEEDS_ENRICHMENT', () => {
    const r = evaluateQualification([], ctx(), QUALIFICATION_RULES);
    expect(r.decision).toBe('REVIEW');
    expect(r.nextStep).toBe('NEEDS_ENRICHMENT');
    expect(r.deterministicScore).toBeNull();
    expect(r.priority).toBe('UNASSIGNED');
  });

  it('missing rating/reviews is still scored (not enrichment)', () => {
    const r = evaluateQualification(
      mkFacts({
        business_name: 'Bright Smile Dental',
        business_status: 'OPERATIONAL',
        category: 'dentist',
        official_domain: 'brightsmile.example',
        phone: '01614960001',
        ownership_type: 'INDEPENDENT',
      }),
      ctx(),
      QUALIFICATION_RULES,
    );
    expect(r.nextStep).not.toBe('NEEDS_ENRICHMENT');
    expect(r.deterministicScore).not.toBeNull();
  });

  it('verified CHAIN with excludeChains → REJECT', () => {
    const r = evaluateQualification(
      mkFacts({ ...STRONG, ownership_type: 'CHAIN' }),
      ctx(),
      QUALIFICATION_RULES,
    );
    expect(r.decision).toBe('REJECT');
    expect(r.triggeredRules).toContain('gate.verifiedChain');
  });

  it('name matching chainNames only FLAGS a possible chain (never rejects)', () => {
    const niche: QualificationNiche = { ...NICHE, chainNames: ['bright smile dental'] };
    const r = evaluateQualification(mkFacts(STRONG), ctx({ niche }), QUALIFICATION_RULES);
    expect(r.decision).not.toBe('REJECT');
    expect(r.triggeredRules).toContain('flag.possibleChain');
  });

  it('wrong niche → REJECT', () => {
    const r = evaluateQualification(
      mkFacts({ ...STRONG, category: 'restaurant' }),
      ctx(),
      QUALIFICATION_RULES,
    );
    expect(r.decision).toBe('REJECT');
    expect(r.triggeredRules).toContain('gate.outsideNiche');
  });

  it('suppressed → REJECT', () => {
    const r = evaluateQualification(mkFacts(STRONG), ctx({ suppressed: true }), QUALIFICATION_RULES);
    expect(r.decision).toBe('REJECT');
    expect(r.triggeredRules).toContain('gate.suppressed');
  });

  it('accept threshold boundary (composite 55 ACCEPT / 52 REVIEW)', () => {
    // viability 25 (rating only) + auditability 100 → composite 55 → ACCEPT
    const accept = evaluateQualification(
      mkFacts({
        business_name: 'X',
        business_status: 'UNKNOWN',
        category: 'dentist',
        official_domain: 'x.example',
        rating: 4.6,
      }),
      ctx(),
      QUALIFICATION_RULES,
    );
    expect(accept.deterministicScore).toBe(55);
    expect(accept.decision).toBe('ACCEPT');

    // viability 20 (reviews only) + auditability 100 → composite 52 → REVIEW
    const review = evaluateQualification(
      mkFacts({
        business_name: 'X',
        business_status: 'UNKNOWN',
        category: 'dentist',
        official_domain: 'x.example',
        review_count: 40,
      }),
      ctx(),
      QUALIFICATION_RULES,
    );
    expect(review.deterministicScore).toBe(52);
    expect(review.decision).toBe('REVIEW');
  });

  it('rule-version change alters version, config hash and decision', () => {
    const strict = { ...QUALIFICATION_RULES, version: 'q-test-strict', acceptThreshold: 95 };
    const base = evaluateQualification(mkFacts(STRONG), ctx(), QUALIFICATION_RULES);
    const withStrict = evaluateQualification(mkFacts(STRONG), ctx(), strict);
    expect(base.decision).toBe('ACCEPT');
    expect(withStrict.decision).toBe('REVIEW');
    expect(withStrict.rulesVersion).toBe('q-test-strict');
    expect(withStrict.rulesConfigHash).not.toBe(base.rulesConfigHash);
  });

  it('identical inputs produce a stable input fingerprint', () => {
    const a = evaluateQualification(mkFacts(STRONG), ctx(), QUALIFICATION_RULES);
    const b = evaluateQualification(mkFacts(STRONG), ctx(), QUALIFICATION_RULES);
    expect(a.inputFingerprint).toBe(b.inputFingerprint);
  });
});
