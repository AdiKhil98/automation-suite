import { describe, expect, it } from 'vitest';
import {
  classifyLead,
  selectResolveBatchTargets,
  type ResolveCascadeProvider,
} from '../../src/domain/contact-resolve-batch/eligibility.js';
import { computeInputHash } from '../../src/domain/contact-enrichment/service.js';
import { type CandidatePerson, type ContactEnrichmentResult } from '../../src/domain/contact-enrichment/types.js';
import { type Lead } from '../../src/domain/leads/lead.js';
import { type LeadStatus } from '../../src/domain/leads/status.js';

const DOMAIN = 'diamond-smile.com';
const CANDIDATES: CandidatePerson[] = [
  { fullName: 'Shyam Shastri', firstName: 'Shyam', lastName: 'Shastri', title: 'Principal Dentist', priority: 1 },
  { fullName: 'Shaimil Patel', firstName: 'Shaimil', lastName: 'Patel', title: 'Clinical Director', priority: 2 },
  { fullName: 'Kymya Doyley', firstName: 'Kymya', lastName: 'Doyley', title: 'Practice Manager', priority: 3 },
];
const BOTH: readonly ResolveCascadeProvider[] = ['instantly', 'hunter'];

function lead(over: Partial<Lead> = {}): Lead {
  return {
    id: 'lead-1', businessName: 'Diamond Smile', normalizedName: null, domain: null, normalizedDomain: null,
    phone: null, normalizedPhone: null, formattedAddress: null, normalizedAddress: null, latitude: null,
    longitude: null, placeId: null, city: null, country: null, status: 'QUALIFIED' as LeadStatus,
    priority: null, source: 'mock', dedupStatus: 'UNIQUE', duplicateOf: null,
    createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'), ...over,
  };
}

function row(over: Partial<ContactEnrichmentResult>): ContactEnrichmentResult {
  return {
    id: 'r1', leadId: 'lead-1', provider: 'hunter', mode: 'ENRICH', inputHash: 'h',
    requestedDomain: DOMAIN, candidates: CANDIDATES, outcome: 'NOT_FOUND', accepted: null,
    creditsEstimated: 0, creditsReported: null, providerResourceId: null, endpoint: null,
    provenance: {}, createdAt: new Date(), completedAt: null, ...over,
  };
}

describe('classifyLead', () => {
  it('skips a lead never durably qualified (no STATE_TRANSITION to QUALIFIED in its history), regardless of current status', () => {
    const d = classifyLead(lead({ status: 'READY_FOR_ENRICHMENT' }), false, DOMAIN, CANDIDATES, [], BOTH, null);
    expect(d).toEqual({ eligible: false, reason: 'not_qualified' });
  });

  it('a lead durably qualified in the past remains eligible even though its CURRENT status has moved on to AUDITED', () => {
    const d = classifyLead(lead({ status: 'AUDITED' }), true, DOMAIN, CANDIDATES, [], BOTH, 62);
    expect(d.eligible).toBe(true);
  });

  it('skips a durably-qualified lead whose current status is REJECTED', () => {
    const d = classifyLead(lead({ status: 'REJECTED' }), true, DOMAIN, CANDIDATES, [], BOTH, null);
    expect(d).toEqual({ eligible: false, reason: 'rejected_or_active_outreach' });
  });

  it('skips a durably-qualified lead with active outreach in flight (EMAIL_DRAFTED)', () => {
    const d = classifyLead(lead({ status: 'EMAIL_DRAFTED' }), true, DOMAIN, CANDIDATES, [], BOTH, null);
    expect(d).toEqual({ eligible: false, reason: 'rejected_or_active_outreach' });
  });

  it('skips a durably-qualified lead that already replied or unsubscribed', () => {
    expect(classifyLead(lead({ status: 'REPLIED' }), true, DOMAIN, CANDIDATES, [], BOTH, null)).toEqual({ eligible: false, reason: 'rejected_or_active_outreach' });
    expect(classifyLead(lead({ status: 'UNSUBSCRIBED' }), true, DOMAIN, CANDIDATES, [], BOTH, null)).toEqual({ eligible: false, reason: 'rejected_or_active_outreach' });
  });

  it('a durably-qualified lead currently BOUNCED remains lifecycle-eligible (previous contact was simply unusable)', () => {
    const d = classifyLead(lead({ status: 'BOUNCED' }), true, DOMAIN, CANDIDATES, [], BOTH, null);
    expect(d.eligible).toBe(true);
  });

  it('a durably-qualified lead currently FAILED remains lifecycle-eligible (a technical failure is never an opt-out/reply)', () => {
    const d = classifyLead(lead({ status: 'FAILED' }), true, DOMAIN, CANDIDATES, [], BOTH, null);
    expect(d.eligible).toBe(true);
  });

  it('skips a lead with no verified official_domain', () => {
    const d = classifyLead(lead(), true, null, CANDIDATES, [], BOTH, null);
    expect(d).toEqual({ eligible: false, reason: 'no_verified_domain' });
  });

  it('skips a lead with no known candidates (absent or empty)', () => {
    expect(classifyLead(lead(), true, DOMAIN, undefined, [], BOTH, null)).toEqual({ eligible: false, reason: 'no_known_candidates' });
    expect(classifyLead(lead(), true, DOMAIN, [], [], BOTH, null)).toEqual({ eligible: false, reason: 'no_known_candidates' });
  });

  it('skips a lead that already holds a VERIFIED contact from any past provider/candidate set', () => {
    const results = [row({ provider: 'instantly', outcome: 'VERIFIED', inputHash: 'stale-hash', accepted: { fullName: 'X', title: 'Y', email: 'x@y.com', verificationStatus: 'VERIFIED', dataQuality: null, confidence: null } })];
    const d = classifyLead(lead(), true, DOMAIN, CANDIDATES, results, BOTH, null);
    expect(d).toEqual({ eligible: false, reason: 'already_verified' });
  });

  it('a VERIFIED contact does NOT suppress discovery when the lead has since BOUNCED — a replacement can be resolved', () => {
    const results = [row({ provider: 'instantly', outcome: 'VERIFIED', inputHash: 'stale-hash', accepted: { fullName: 'X', title: 'Y', email: 'x@y.com', verificationStatus: 'VERIFIED', dataQuality: null, confidence: null } })];
    const d = classifyLead(lead({ status: 'BOUNCED' }), true, DOMAIN, CANDIDATES, results, BOTH, null);
    expect(d.eligible).toBe(true);
  });

  it('is eligible with both providers as next steps when nothing has been attempted', () => {
    const d = classifyLead(lead(), true, DOMAIN, CANDIDATES, [], BOTH, 62);
    expect(d.eligible).toBe(true);
    if (d.eligible) {
      expect(d.target.nextSteps).toEqual(['instantly', 'hunter']);
      expect(d.target.maxOpportunityScore).toBe(62);
    }
  });

  it('a CAPPED row still counts as resolved (idempotency replays ANY existing row regardless of outcome)', () => {
    const instantlyHash = computeInputHash('ENRICH', 'instantly', DOMAIN, CANDIDATES);
    const results = [row({ provider: 'instantly', mode: 'ENRICH', outcome: 'CAPPED', inputHash: instantlyHash })];
    const d = classifyLead(lead(), true, DOMAIN, CANDIDATES, results, BOTH, null);
    expect(d.eligible).toBe(true);
    if (d.eligible) expect(d.target.nextSteps).toEqual(['hunter']); // instantly already resolved, even though CAPPED
  });

  it('Diamond Smile shape: Hunter ENRICH CAPPED + a separate DOMAIN_SEARCH_ONLY NOT_FOUND together resolve the Hunter step', () => {
    const enrichHash = computeInputHash('ENRICH', 'hunter', DOMAIN, CANDIDATES);
    const dsHash = computeInputHash('DOMAIN_SEARCH_ONLY', 'hunter', DOMAIN, CANDIDATES);
    const results = [
      row({ provider: 'hunter', mode: 'ENRICH', outcome: 'CAPPED', inputHash: enrichHash }),
      row({ provider: 'hunter', mode: 'DOMAIN_SEARCH_ONLY', outcome: 'NOT_FOUND', inputHash: dsHash }),
    ];
    const d = classifyLead(lead(), true, DOMAIN, CANDIDATES, results, BOTH, null);
    expect(d.eligible).toBe(true);
    if (d.eligible) expect(d.target.nextSteps).toEqual(['instantly']); // hunter's path is exhausted, skip it
  });

  it('Diamond Smile shape + Instantly also resolved -> the whole chain is conclusively exhausted', () => {
    const enrichHash = computeInputHash('ENRICH', 'hunter', DOMAIN, CANDIDATES);
    const dsHash = computeInputHash('DOMAIN_SEARCH_ONLY', 'hunter', DOMAIN, CANDIDATES);
    const instantlyHash = computeInputHash('ENRICH', 'instantly', DOMAIN, CANDIDATES);
    const results = [
      row({ provider: 'hunter', mode: 'ENRICH', outcome: 'CAPPED', inputHash: enrichHash }),
      row({ provider: 'hunter', mode: 'DOMAIN_SEARCH_ONLY', outcome: 'NOT_FOUND', inputHash: dsHash }),
      row({ provider: 'instantly', mode: 'ENRICH', outcome: 'NOT_FOUND', inputHash: instantlyHash }),
    ];
    const d = classifyLead(lead(), true, DOMAIN, CANDIDATES, results, BOTH, null);
    expect(d).toEqual({ eligible: false, reason: 'chain_exhausted' });
  });

  it('a resolved step for a provider NOT available this run is simply not offered, but does not itself exhaust the lead', () => {
    const instantlyHash = computeInputHash('ENRICH', 'instantly', DOMAIN, CANDIDATES);
    const results = [row({ provider: 'instantly', mode: 'ENRICH', outcome: 'NOT_FOUND', inputHash: instantlyHash })];
    // Only hunter is available this run (e.g. instantly not configured) -> hunter is still a fresh next step.
    const d = classifyLead(lead(), true, DOMAIN, CANDIDATES, results, ['hunter'], null);
    expect(d.eligible).toBe(true);
    if (d.eligible) expect(d.target.nextSteps).toEqual(['hunter']);
  });
});

describe('selectResolveBatchTargets', () => {
  it('orders eligible leads by strongest opportunity score first, then createdAt/id tie-break, and caps at limit', () => {
    const leads = [
      lead({ id: 'low', createdAt: new Date('2026-01-01T00:00:00Z') }),
      lead({ id: 'high', createdAt: new Date('2026-01-02T00:00:00Z') }),
      lead({ id: 'none', createdAt: new Date('2026-01-03T00:00:00Z') }),
    ];
    const durablyQualifiedLeadIds = new Set(leads.map((l) => l.id));
    const officialDomainByLead = new Map(leads.map((l) => [l.id, DOMAIN]));
    const candidatesByLead = new Map(leads.map((l) => [l.id, CANDIDATES]));
    const existingResultsByLead = new Map(leads.map((l) => [l.id, [] as ContactEnrichmentResult[]]));
    const maxOpportunityScoreByLead = new Map([['low', 20], ['high', 90]]);
    const { selected, skipped } = selectResolveBatchTargets(
      leads,
      { durablyQualifiedLeadIds, officialDomainByLead, candidatesByLead, existingResultsByLead, maxOpportunityScoreByLead, availableProviders: BOTH },
      { limit: 2 },
    );
    expect(selected.map((t) => t.lead.id)).toEqual(['high', 'low']); // 'none' has no score -> sorts last -> excluded by limit
    expect(skipped).toEqual([]);
  });

  it('reports a full skip breakdown by reason', () => {
    const leads = [lead({ id: 'a', status: 'NEW' }), lead({ id: 'b' })]; // a: never qualified; b: QUALIFIED but no domain
    const durablyQualifiedLeadIds = new Set(['b']);
    const officialDomainByLead = new Map<string, string | null>([['b', null]]);
    const { selected, skipped } = selectResolveBatchTargets(
      leads,
      { durablyQualifiedLeadIds, officialDomainByLead, candidatesByLead: new Map(), existingResultsByLead: new Map(), maxOpportunityScoreByLead: new Map(), availableProviders: BOTH },
      { limit: 10 },
    );
    expect(selected).toHaveLength(0);
    expect(skipped).toEqual([
      { lead: leads[0], reason: 'not_qualified' },
      { lead: leads[1], reason: 'no_verified_domain' },
    ]);
  });

  it('a durably-qualified lead now AUDITED is selected alongside a durably-qualified lead still QUALIFIED', () => {
    const leads = [lead({ id: 'still-qualified', status: 'QUALIFIED' }), lead({ id: 'now-audited', status: 'AUDITED' })];
    const durablyQualifiedLeadIds = new Set(['still-qualified', 'now-audited']);
    const officialDomainByLead = new Map(leads.map((l) => [l.id, DOMAIN]));
    const candidatesByLead = new Map(leads.map((l) => [l.id, CANDIDATES]));
    const existingResultsByLead = new Map(leads.map((l) => [l.id, [] as ContactEnrichmentResult[]]));
    const { selected, skipped } = selectResolveBatchTargets(
      leads,
      { durablyQualifiedLeadIds, officialDomainByLead, candidatesByLead, existingResultsByLead, maxOpportunityScoreByLead: new Map(), availableProviders: BOTH },
      { limit: 10 },
    );
    expect(selected.map((t) => t.lead.id).sort()).toEqual(['now-audited', 'still-qualified']);
    expect(skipped).toEqual([]);
  });
});
