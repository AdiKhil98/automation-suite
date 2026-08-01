import { describe, expect, it } from 'vitest';
import { finalizeObservation } from '../../../src/domain/competitor/evidence-confidence.js';
import { type EvidenceObservation } from '../../../src/domain/competitor/evidence-types.js';

function obs(over: Partial<EvidenceObservation>): EvidenceObservation {
  return {
    competitorCandidateId: 'c',
    evidenceCategory: 'PHONE_VISIBLE',
    observationKind: 'DIRECT_OBSERVATION',
    observation: 'x',
    sourcePageUrl: 'https://a.de',
    normalizedOrigin: 'a.de',
    selector: 'a',
    sourceExcerpt: null,
    profile: 'desktop',
    numericValue: null,
    confidence: 'HIGH',
    withholdingReason: null,
    ...over,
  };
}

describe('finalizeObservation', () => {
  it('blocks UNSUPPORTED_INFERENCE regardless of confidence (performance inference never usable)', () => {
    const r = finalizeObservation(obs({ observationKind: 'UNSUPPORTED_INFERENCE', confidence: 'HIGH' }), 'FRESH');
    expect(r).toEqual({ withholdingReason: 'PERFORMANCE_INFERENCE', safeForOutreach: false, active: false });
  });

  it('preserves a detector-supplied withholding reason (e.g. AMBIGUOUS)', () => {
    const r = finalizeObservation(obs({ withholdingReason: 'AMBIGUOUS', confidence: 'LOW' }), 'FRESH');
    expect(r.withholdingReason).toBe('AMBIGUOUS');
    expect(r.active).toBe(false);
  });

  it('withholds LOW confidence', () => {
    const r = finalizeObservation(obs({ confidence: 'LOW' }), 'FRESH');
    expect(r).toEqual({ withholdingReason: 'LOW_CONFIDENCE', safeForOutreach: false, active: false });
  });

  it('makes a HIGH, fresh, direct observation safe-for-outreach + active', () => {
    expect(finalizeObservation(obs({ confidence: 'HIGH' }), 'FRESH')).toEqual({ withholdingReason: null, safeForOutreach: true, active: true });
  });

  it('keeps a stale observation active (historical) but NOT safe-for-outreach', () => {
    expect(finalizeObservation(obs({ confidence: 'MEDIUM' }), 'STALE')).toEqual({ withholdingReason: null, safeForOutreach: false, active: true });
  });
});
