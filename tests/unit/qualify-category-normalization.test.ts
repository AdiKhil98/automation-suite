import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { QUALIFICATION_RULES } from '../../src/config/qualification-rules.js';
import { type FactType, type LeadFact } from '../../src/domain/lead-facts/lead-fact.js';
import { normalizeName } from '../../src/domain/leads/normalize.js';
import {
  evaluateQualification,
  normalizeCategory,
  type QualificationNiche,
} from '../../src/domain/qualification/qualify.js';

const NOW = new Date('2026-08-06T00:00:00Z');

// The dental niche as configured: allowlist uses a SPACE ("dental clinic"),
// while Google Places emits the underscore form ("dental_clinic").
const DENTAL_NICHE: QualificationNiche = {
  allowedCategories: ['dentist', 'dental clinic', 'orthodontist'],
  excludeChains: true,
  chainNames: [],
};

function mkFacts(spec: Partial<Record<FactType, string | number>>): LeadFact[] {
  return Object.entries(spec).map(([type, raw]) => {
    const value = String(raw);
    const normalizable = type === 'business_name' || type === 'category';
    return {
      id: randomUUID(),
      leadId: 'L1',
      factType: type as FactType,
      value,
      // Mirrors production: category normalizedValue = normalizeName(value), which
      // lowercases/trims but KEEPS underscores — so the gate itself must normalize.
      normalizedValue: normalizable ? normalizeName(value) : null,
      sourceType: 'mock',
      sourceUrl: null,
      capturedAt: NOW,
      confidence: 1,
      supersededBy: null,
      supersededAt: null,
      isCurrent: true,
    } satisfies LeadFact;
  });
}

const STRONG = {
  business_name: 'Example Dental Practice',
  business_status: 'OPERATIONAL',
  phone: '02086801234',
  official_domain: 'example-dental.example',
  ownership_type: 'INDEPENDENT',
  rating: 4.7,
  review_count: 130,
} as const;

function evalCategory(category: string, niche: QualificationNiche = DENTAL_NICHE) {
  return evaluateQualification(
    mkFacts({ ...STRONG, category }),
    { leadId: 'L1', campaign: 'test', niche, suppressed: false, now: NOW },
    QUALIFICATION_RULES,
  );
}

describe('normalizeCategory (canonical form)', () => {
  it('reconciles case / underscore / hyphen / repeated whitespace', () => {
    expect(normalizeCategory('dental_clinic')).toBe('dental clinic');
    expect(normalizeCategory('dental clinic')).toBe('dental clinic');
    expect(normalizeCategory('Dental-Clinic')).toBe('dental clinic');
    expect(normalizeCategory('  DENTAL   CLINIC  ')).toBe('dental clinic');
  });
  it('all representational variants collapse to one value', () => {
    const forms = ['dental_clinic', 'dental clinic', 'Dental-Clinic', '  DENTAL   CLINIC  ', 'DENTAL_CLINIC'];
    expect(new Set(forms.map(normalizeCategory)).size).toBe(1);
  });
});

describe('niche-category gate — normalized equality only', () => {
  it('dental_clinic (provider) matches "dental clinic" (allowlist) → not outside-niche, ACCEPT', () => {
    const r = evalCategory('dental_clinic');
    expect(r.triggeredRules).not.toContain('gate.outsideNiche');
    expect(r.decision).toBe('ACCEPT');
  });
  it('hyphenated and mixed-case equivalents match', () => {
    expect(evalCategory('Dental-Clinic').triggeredRules).not.toContain('gate.outsideNiche');
    expect(evalCategory('DENTAL_CLINIC').triggeredRules).not.toContain('gate.outsideNiche');
  });
  it('repeated whitespace matches', () => {
    expect(evalCategory('dental   clinic').triggeredRules).not.toContain('gate.outsideNiche');
  });
  it('existing "dentist" behaviour is unchanged → ACCEPT', () => {
    const r = evalCategory('dentist');
    expect(r.decision).toBe('ACCEPT');
    expect(r.triggeredRules).not.toContain('gate.outsideNiche');
  });
  it('unrelated categories still fail the niche gate', () => {
    for (const c of ['restaurant', 'hospital', 'pharmacy']) {
      const r = evalCategory(c);
      expect(r.decision).toBe('REJECT');
      expect(r.triggeredRules).toContain('gate.outsideNiche');
    }
  });
  it('no substring match: "dental" alone does NOT match "dental clinic"', () => {
    const r = evalCategory('dental');
    expect(r.triggeredRules).toContain('gate.outsideNiche');
  });
  it('no broadened acceptance: a near-but-not-allowlisted category is rejected', () => {
    // "dental_practice" normalizes to "dental practice", which is NOT in the allowlist.
    const r = evalCategory('dental_practice');
    expect(r.triggeredRules).toContain('gate.outsideNiche');
  });
});
