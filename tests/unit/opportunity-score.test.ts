import { describe, expect, it } from 'vitest';
import { OPPORTUNITY_RULES, opportunityRulesHash, scoreOpportunity } from '../../src/domain/audit/opportunity-score.js';
import { acceptedFinding } from './helpers/audit-fixtures.js';

const noLimits = { severeCaptureLimitations: false };

describe('scoreOpportunity', () => {
  it('returns zero scores for no findings', () => {
    const r = scoreOpportunity([], noLimits);
    expect(r.scores).toEqual({ conversion: 0, mobile: 0, trust: 0, contactability: 0, overall: 0 });
    expect(r.breakdown).toEqual([]);
    expect(r.rulesVersion).toBe('opp-rules-1');
  });

  it('is deterministic: identical inputs produce identical results', () => {
    const findings = [acceptedFinding({ findingRef: 'F1' }), acceptedFinding({ findingRef: 'F2', category: 'TRUST_SIGNALS' })];
    const a = scoreOpportunity(findings, noLimits);
    const b = scoreOpportunity(findings, noLimits);
    expect(a).toEqual(b);
    expect(a.rulesConfigHash).toBe(opportunityRulesHash(OPPORTUNITY_RULES));
  });

  it('weights severity: HIGH contributes more than LOW', () => {
    const high = scoreOpportunity([acceptedFinding({ severity: 'HIGH' })], noLimits);
    const low = scoreOpportunity([acceptedFinding({ severity: 'LOW' })], noLimits);
    expect(high.scores.conversion).toBeGreaterThan(low.scores.conversion);
  });

  it('discounts low confidence', () => {
    const confident = scoreOpportunity([acceptedFinding({ confidence: 0.9 })], noLimits);
    const unsure = scoreOpportunity([acceptedFinding({ confidence: 0.3 })], noLimits);
    expect(confident.scores.conversion).toBeGreaterThan(unsure.scores.conversion);
  });

  it('applies the mobile profile multiplier', () => {
    const mobile = scoreOpportunity([acceptedFinding({ affectedProfiles: ['MOBILE'] })], noLimits);
    const desktop = scoreOpportunity([acceptedFinding({ affectedProfiles: ['DESKTOP'] })], noLimits);
    expect(mobile.breakdown[0]?.profileMultiplier).toBe(OPPORTUNITY_RULES.mobileProfileMultiplier);
    expect(mobile.scores.conversion).toBeGreaterThanOrEqual(desktop.scores.conversion);
  });

  it('halves repeated findings in the same category (dedup)', () => {
    const r = scoreOpportunity(
      [acceptedFinding({ findingRef: 'F1' }), acceptedFinding({ findingRef: 'F2' })],
      noLimits,
    );
    expect(r.breakdown[0]?.dedupAdjustment).toBe(1);
    expect(r.breakdown[1]?.dedupAdjustment).toBe(OPPORTUNITY_RULES.dedupFactor);
  });

  it('maps categories to their dimensions', () => {
    const r = scoreOpportunity(
      [
        acceptedFinding({ category: 'MOBILE_USABILITY' }),
        acceptedFinding({ category: 'TRUST_SIGNALS' }),
        acceptedFinding({ category: 'CONTACT_FRICTION' }),
      ],
      noLimits,
    );
    expect(r.scores.mobile).toBeGreaterThan(0);
    expect(r.scores.trust).toBeGreaterThan(0);
    expect(r.scores.contactability).toBeGreaterThan(0);
    expect(r.scores.conversion).toBeGreaterThan(0); // CONTACT_FRICTION also feeds conversion
  });

  it('caps overall when no finding is outreach-safe', () => {
    const findings = ['BOOKING_FRICTION', 'CONTACT_FRICTION', 'TRUST_SIGNALS', 'MOBILE_USABILITY'].map((cat, i) =>
      acceptedFinding({ findingRef: `F${String(i)}`, category: cat as never, severity: 'HIGH', safeForOutreach: false }),
    );
    const r = scoreOpportunity(findings, noLimits);
    expect(r.scores.overall).toBeLessThanOrEqual(OPPORTUNITY_RULES.noOutreachSafeOverallCap);
    expect(r.capsApplied).toContain('no_outreach_safe_cap');
  });

  it('caps overall under severe capture limitations', () => {
    const findings = ['BOOKING_FRICTION', 'CONTACT_FRICTION', 'TRUST_SIGNALS', 'MOBILE_USABILITY'].map((cat, i) =>
      acceptedFinding({ findingRef: `F${String(i)}`, category: cat as never, severity: 'HIGH' }),
    );
    const r = scoreOpportunity(findings, { severeCaptureLimitations: true });
    expect(r.scores.overall).toBeLessThanOrEqual(OPPORTUNITY_RULES.severeCaptureLimitationOverallCap);
    expect(r.capsApplied).toContain('severe_capture_limitation_cap');
  });

  it('produces an explainable breakdown whose rows carry all multipliers', () => {
    const r = scoreOpportunity([acceptedFinding({ category: 'BOOKING_FRICTION', severity: 'HIGH', confidence: 0.9 })], noLimits);
    const row = r.breakdown[0];
    expect(row).toMatchObject({
      baseWeight: OPPORTUNITY_RULES.severityWeight.HIGH,
      confidenceMultiplier: OPPORTUNITY_RULES.confidenceFactor.high,
      categoryMultiplier: OPPORTUNITY_RULES.categoryMultiplier.BOOKING_FRICTION,
      dedupAdjustment: 1,
    });
    expect(row?.finalContribution).toBeGreaterThan(0);
  });

  it('applies the per-finding cap', () => {
    const r = scoreOpportunity(
      [acceptedFinding({ category: 'BOOKING_FRICTION', severity: 'HIGH', confidence: 0.95, affectedProfiles: ['MOBILE'] })],
      noLimits,
    );
    expect(r.breakdown[0]?.capApplied).toBe(true);
    expect(r.breakdown[0]?.finalContribution).toBe(OPPORTUNITY_RULES.perFindingCap);
  });

  it('keeps all scores within 0-100', () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      acceptedFinding({ findingRef: `F${String(i)}`, category: 'BOOKING_FRICTION', severity: 'HIGH' }),
    );
    const r = scoreOpportunity(many, noLimits);
    for (const v of Object.values(r.scores)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });
});
