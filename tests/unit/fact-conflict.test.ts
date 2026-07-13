import { describe, expect, it } from 'vitest';
import { resolveFactWrite } from '../../src/domain/enrichment/fact-conflict.js';
import { type LeadFact } from '../../src/domain/lead-facts/lead-fact.js';
import { type ExtractedFact } from '../../src/domain/enrichment/types.js';

function existing(over: Partial<LeadFact>): LeadFact {
  return {
    id: 'f1',
    leadId: 'L1',
    factType: 'phone',
    value: '01614960000',
    normalizedValue: '1614960000',
    sourceType: 'mock',
    sourceUrl: null,
    capturedAt: new Date(),
    confidence: 0.9,
    supersededBy: null,
    supersededAt: null,
    isCurrent: true,
    ...over,
  };
}

const incoming = (over: Partial<ExtractedFact>): ExtractedFact => ({
  factType: 'phone',
  value: '01610000000',
  normalizedValue: '1610000000',
  sourceUrl: 'https://acme.example',
  confidence: 0.9,
  ...over,
});

describe('resolveFactWrite', () => {
  it('inserts when there is no current fact', () => {
    expect(resolveFactWrite(null, incoming({})).action).toBe('insert');
  });
  it('is a no-op when the value is unchanged (attach evidence to existing)', () => {
    const same = incoming({ value: '1614960000', normalizedValue: '1614960000' });
    const r = resolveFactWrite(existing({}), same);
    expect(r.action).toBe('noop');
  });
  it('preserves a manual fact and routes to review on conflict', () => {
    const r = resolveFactWrite(existing({ sourceType: 'manual' }), incoming({}));
    expect(r.action).toBe('conflict');
    expect(r.routeManualReview).toBe(true);
  });
  it('supersedes weaker (mock) provenance with a verified website value', () => {
    expect(resolveFactWrite(existing({ sourceType: 'mock' }), incoming({})).action).toBe('supersede');
  });
  it('for two website values, supersedes only when strictly more confident', () => {
    const web = existing({ sourceType: 'website', confidence: 0.9 });
    expect(resolveFactWrite(web, incoming({ confidence: 0.95 })).action).toBe('supersede');
    expect(resolveFactWrite(web, incoming({ confidence: 0.8 })).action).toBe('noop');
  });
});
