import { describe, expect, it } from 'vitest';

import { selectLeadsToEnrich } from '../../src/cli/commands/enrich-leads.js';
import { type Lead } from '../../src/domain/leads/lead.js';
import { type LeadStatus } from '../../src/domain/leads/status.js';

function makeLead(id: string, status: LeadStatus, createdAt: Date): Lead {
  return {
    id,
    businessName: null,
    normalizedName: null,
    domain: null,
    normalizedDomain: null,
    phone: null,
    normalizedPhone: null,
    formattedAddress: null,
    normalizedAddress: null,
    latitude: null,
    longitude: null,
    placeId: `place-${id}`,
    city: null,
    country: null,
    status,
    priority: null,
    source: 'google_places',
    dedupStatus: 'UNIQUE',
    duplicateOf: null,
    createdAt,
    updatedAt: createdAt,
  };
}

// A realistic mix: the approved fresh London lead + the forbidden old stubs, all
// currently READY_FOR_ENRICHMENT (the exact hazard the --lead scope must contain).
const approved = makeLead('approved-fresh-1', 'READY_FOR_ENRICHMENT', new Date('2026-08-04T21:29:30Z'));
const stubA = makeLead('old-stub-a', 'READY_FOR_ENRICHMENT', new Date('2026-07-22T19:58:00Z'));
const stubB = makeLead('old-stub-b', 'READY_FOR_ENRICHMENT', new Date('2026-07-22T19:51:00Z'));
const newLead = makeLead('approved-fresh-2', 'NEW', new Date('2026-08-04T21:29:40Z'));
const allLeads: Lead[] = [approved, stubA, stubB, newLead];

const OPTS = { maxPerRun: 25 };

describe('selectLeadsToEnrich — single-lead (--lead) scope', () => {
  it('selects exactly the requested eligible lead', () => {
    const result = selectLeadsToEnrich(allLeads, { ...OPTS, lead: 'approved-fresh-1' });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('approved-fresh-1');
  });

  it('never selects the forbidden old stubs, even though they are READY_FOR_ENRICHMENT', () => {
    const result = selectLeadsToEnrich(allLeads, { ...OPTS, lead: 'approved-fresh-1' });
    const ids = result.map((l) => l.id);
    expect(ids).not.toContain('old-stub-a');
    expect(ids).not.toContain('old-stub-b');
  });

  it('fails closed for an ineligible (non-READY_FOR_ENRICHMENT) lead', () => {
    expect(() => selectLeadsToEnrich(allLeads, { ...OPTS, lead: 'approved-fresh-2' })).toThrow(
      /not READY_FOR_ENRICHMENT/,
    );
  });

  it('fails closed for an unknown lead id', () => {
    expect(() => selectLeadsToEnrich(allLeads, { ...OPTS, lead: 'does-not-exist' })).toThrow(/not found/);
  });

  it('selects at most one lead (single-lead maximum)', () => {
    const result = selectLeadsToEnrich(allLeads, { ...OPTS, lead: 'approved-fresh-1', limit: 10 });
    expect(result).toHaveLength(1);
  });

  it('never falls back to the global queue when --lead is given', () => {
    // Even with a generous limit, only the one requested lead is returned.
    const result = selectLeadsToEnrich(allLeads, { ...OPTS, lead: 'approved-fresh-1', limit: 99 });
    expect(result.map((l) => l.id)).toEqual(['approved-fresh-1']);
  });

  it('is idempotent — repeated selection yields the same single lead (no retry/accumulation)', () => {
    const a = selectLeadsToEnrich(allLeads, { ...OPTS, lead: 'approved-fresh-1' });
    const b = selectLeadsToEnrich(allLeads, { ...OPTS, lead: 'approved-fresh-1' });
    expect(a.map((l) => l.id)).toEqual(['approved-fresh-1']);
    expect(b.map((l) => l.id)).toEqual(['approved-fresh-1']);
  });
});

describe('selectLeadsToEnrich — batch mode (unchanged behaviour)', () => {
  it('selects all READY_FOR_ENRICHMENT leads when no --lead is given', () => {
    const result = selectLeadsToEnrich(allLeads, OPTS);
    expect(result.map((l) => l.id).sort()).toEqual(['approved-fresh-1', 'old-stub-a', 'old-stub-b']);
  });

  it('respects the --limit slice', () => {
    const result = selectLeadsToEnrich(allLeads, { ...OPTS, limit: 1 });
    expect(result).toHaveLength(1);
  });

  it('respects MAX_ENRICHMENTS_PER_RUN', () => {
    const result = selectLeadsToEnrich(allLeads, { maxPerRun: 2 });
    expect(result).toHaveLength(2);
  });
});
