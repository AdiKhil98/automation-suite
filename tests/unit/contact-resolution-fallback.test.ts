import { describe, expect, it } from 'vitest';
import { evaluateOfficialInboxFallback } from '../../src/domain/contact-resolution/official-inbox-fallback.js';
import { toIntendedDecisionMakers } from '../../src/domain/contact-resolution/resolution.js';
import { classifyLead, selectResolveBatchTargets, type ResolveCascadeProvider } from '../../src/domain/contact-resolve-batch/eligibility.js';
import { computeInputHash } from '../../src/domain/contact-enrichment/service.js';
import { type CandidatePerson, type ContactEnrichmentResult } from '../../src/domain/contact-enrichment/types.js';
import { type LeadFact } from '../../src/domain/lead-facts/lead-fact.js';
import { type Lead } from '../../src/domain/leads/lead.js';
import { type LeadStatus } from '../../src/domain/leads/status.js';

/**
 * The GENERIC_OFFICIAL fallback. "Complete Dentistry" is the primary regression scenario: a lead
 * whose personal Instantly/Hunter cascade is conclusively exhausted with no VERIFIED person, which
 * is exactly the state that must be able to fall back to the practice's own published inbox.
 */

const DOMAIN = 'completedentistry.co.uk';
const CANDIDATES: CandidatePerson[] = [
  { fullName: 'Richard Clarke-Irons', firstName: 'Richard', lastName: 'Clarke-Irons', title: 'Principal Dentist', priority: 1 },
  { fullName: 'Sarah Lowe', firstName: 'Sarah', lastName: 'Lowe', title: 'Practice Manager', priority: 2 },
];
const BOTH: readonly ResolveCascadeProvider[] = ['instantly', 'hunter'];

function lead(over: Partial<Lead> = {}): Lead {
  return {
    id: 'complete-dentistry', businessName: 'Complete Dentistry', normalizedName: null, domain: null,
    normalizedDomain: null, phone: null, normalizedPhone: null, formattedAddress: null, normalizedAddress: null,
    latitude: null, longitude: null, placeId: null, city: null, country: null, status: 'AUDITED' as LeadStatus,
    priority: null, source: 'mock', dedupStatus: 'UNIQUE', duplicateOf: null,
    createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'), ...over,
  };
}

function row(over: Partial<ContactEnrichmentResult>): ContactEnrichmentResult {
  return {
    id: 'r1', leadId: 'complete-dentistry', provider: 'hunter', mode: 'ENRICH', inputHash: 'h',
    requestedDomain: DOMAIN, candidates: CANDIDATES, outcome: 'NOT_FOUND', accepted: null,
    creditsEstimated: 0, creditsReported: null, providerResourceId: null, endpoint: null,
    provenance: {}, createdAt: new Date(), completedAt: null, ...over,
  };
}

/** The exact persisted shape of a conclusively exhausted personal cascade. */
function exhaustedChain(): ContactEnrichmentResult[] {
  return [
    row({ provider: 'instantly', mode: 'ENRICH', outcome: 'NOT_FOUND', inputHash: computeInputHash('ENRICH', 'instantly', DOMAIN, CANDIDATES) }),
    row({ provider: 'hunter', mode: 'ENRICH', outcome: 'NOT_FOUND', inputHash: computeInputHash('ENRICH', 'hunter', DOMAIN, CANDIDATES) }),
  ];
}

function fact(over: Partial<LeadFact> = {}): LeadFact {
  return {
    id: 'fact-1', leadId: 'complete-dentistry', factType: 'contact_email', value: 'info@completedentistry.co.uk',
    normalizedValue: 'info@completedentistry.co.uk', sourceType: 'website',
    sourceUrl: 'https://completedentistry.co.uk/contact', capturedAt: new Date(), confidence: 0.9,
    supersededBy: null, supersededAt: null, isCurrent: true, ...over,
  };
}

describe('evaluateOfficialInboxFallback — acceptance', () => {
  it('accepts a published, same-domain, generic inbox and retains its provenance', () => {
    const d = evaluateOfficialInboxFallback(DOMAIN, fact());
    expect(d).toEqual({
      accepted: true,
      email: 'info@completedentistry.co.uk',
      normalizedLocalPart: 'info',
      sourceFactId: 'fact-1',
      sourceUrl: 'https://completedentistry.co.uk/contact',
    });
  });

  it('accepts reception/enquiries-style inboxes and normalizes a mailto: value to the bare address', () => {
    const d = evaluateOfficialInboxFallback(DOMAIN, fact({ value: 'mailto:Enquiries@CompleteDentistry.co.uk?subject=Hi' }));
    expect(d.accepted).toBe(true);
    if (d.accepted) expect(d.email).toBe('enquiries@completedentistry.co.uk');
  });

  it('tolerates a www-prefixed official_domain fact', () => {
    expect(evaluateOfficialInboxFallback('www.completedentistry.co.uk', fact()).accepted).toBe(true);
  });
});

describe('evaluateOfficialInboxFallback — refusals', () => {
  it('refuses when no contact_email fact exists at all: the lead stays UNRESOLVED', () => {
    expect(evaluateOfficialInboxFallback(DOMAIN, null)).toEqual({ accepted: false, reason: 'no_contact_email_fact' });
    expect(evaluateOfficialInboxFallback(DOMAIN, fact({ value: '   ' }))).toEqual({ accepted: false, reason: 'no_contact_email_fact' });
  });

  it('refuses when the lead has no verified official domain to match against', () => {
    expect(evaluateOfficialInboxFallback(null, fact())).toEqual({ accepted: false, reason: 'no_official_domain' });
  });

  it('GUESSED ADDRESSES ARE STRUCTURALLY IMPOSSIBLE: only a website-sourced fact qualifies', () => {
    // There is no code path that fabricates an address — the ONLY input is a stored fact. A fact
    // whose provenance is not the business's own website cannot prove the address was published,
    // so manual/mock/google_places provenance is refused outright.
    for (const sourceType of ['manual', 'mock', 'google_places'] as const) {
      expect(evaluateOfficialInboxFallback(DOMAIN, fact({ sourceType })), sourceType)
        .toEqual({ accepted: false, reason: 'fact_not_website_sourced' });
    }
  });

  it('refuses a website fact with no source URL — provenance must be retained, not assumed', () => {
    expect(evaluateOfficialInboxFallback(DOMAIN, fact({ sourceUrl: null }))).toEqual({ accepted: false, reason: 'fact_missing_source_url' });
  });

  it('refuses a superseded (non-current) fact', () => {
    expect(evaluateOfficialInboxFallback(DOMAIN, fact({ isCurrent: false }))).toEqual({ accepted: false, reason: 'fact_not_current' });
  });

  it('refuses a WRONG-DOMAIN generic inbox, including a lookalike and a subdomain', () => {
    expect(evaluateOfficialInboxFallback(DOMAIN, fact({ value: 'info@gmail.com' })))
      .toEqual({ accepted: false, reason: 'email_domain_does_not_match_official_domain' });
    expect(evaluateOfficialInboxFallback(DOMAIN, fact({ value: 'info@completedentistry.com' })))
      .toEqual({ accepted: false, reason: 'email_domain_does_not_match_official_domain' });
    expect(evaluateOfficialInboxFallback(DOMAIN, fact({ value: 'info@mail.completedentistry.co.uk' })))
      .toEqual({ accepted: false, reason: 'email_domain_does_not_match_official_domain' });
  });

  it('refuses a syntactically invalid address', () => {
    expect(evaluateOfficialInboxFallback(DOMAIN, fact({ value: 'not-an-email' })))
      .toEqual({ accepted: false, reason: 'email_not_normalizable' });
  });

  it('refuses denylisted mailboxes even on the correct domain', () => {
    for (const local of ['noreply', 'no-reply', 'privacy', 'dpo', 'careers', 'jobs', 'billing', 'accounts']) {
      expect(evaluateOfficialInboxFallback(DOMAIN, fact({ value: `${local}@${DOMAIN}` })), local)
        .toEqual({ accepted: false, reason: 'mailbox_denylisted_system_or_department_mailbox' });
    }
  });

  it('refuses a PERSONAL address on the official domain — that is the personal cascade\'s job, not the fallback\'s', () => {
    expect(evaluateOfficialInboxFallback(DOMAIN, fact({ value: `richard@${DOMAIN}` })))
      .toEqual({ accepted: false, reason: 'mailbox_not_a_recognized_generic_business_mailbox' });
  });
});

describe('fallback ordering — the personal cascade always runs first', () => {
  it('a lead with a VERIFIED personal contact is already_verified and never reaches the fallback', () => {
    const results = [...exhaustedChain(), row({ id: 'v', outcome: 'VERIFIED', accepted: { fullName: 'Richard Clarke-Irons', title: 'Principal Dentist', email: `richard@${DOMAIN}`, verificationStatus: 'VERIFIED', dataQuality: null, confidence: 1 } })];
    const d = classifyLead(lead(), true, DOMAIN, CANDIDATES, results, BOTH, null);
    expect(d).toEqual({ eligible: false, reason: 'already_verified' });

    const { fallbackCandidates } = selectResolveBatchTargets(
      [lead()],
      {
        durablyQualifiedLeadIds: new Set(['complete-dentistry']),
        officialDomainByLead: new Map([['complete-dentistry', DOMAIN]]),
        candidatesByLead: new Map([['complete-dentistry', CANDIDATES]]),
        existingResultsByLead: new Map([['complete-dentistry', results]]),
        maxOpportunityScoreByLead: new Map(),
        availableProviders: BOTH,
      },
      { limit: 10 },
    );
    // PERSONAL_VERIFIED wins outright: the lead is not even a fallback candidate.
    expect(fallbackCandidates).toEqual([]);
  });

  it('a lead with cascade steps still pending is NOT a fallback candidate, even though a valid generic inbox exists', () => {
    const partial = [row({ provider: 'instantly', mode: 'ENRICH', outcome: 'NOT_FOUND', inputHash: computeInputHash('ENRICH', 'instantly', DOMAIN, CANDIDATES) })];
    const d = classifyLead(lead(), true, DOMAIN, CANDIDATES, partial, BOTH, null);
    expect(d.eligible).toBe(true); // hunter still to try — the generic inbox must not short-circuit it
    if (d.eligible) expect(d.target.nextSteps).toEqual(['hunter']);
  });

  it('a lead blocked only by missing provider configuration is NOT a fallback candidate', () => {
    const { fallbackCandidates, skipped } = selectResolveBatchTargets(
      [lead()],
      {
        durablyQualifiedLeadIds: new Set(['complete-dentistry']),
        officialDomainByLead: new Map([['complete-dentistry', DOMAIN]]),
        candidatesByLead: new Map([['complete-dentistry', CANDIDATES]]),
        existingResultsByLead: new Map([['complete-dentistry', []]]),
        maxOpportunityScoreByLead: new Map(),
        availableProviders: [],
      },
      { limit: 10 },
    );
    expect(skipped).toEqual([{ lead: lead(), reason: 'no_providers_configured' }]);
    expect(fallbackCandidates).toEqual([]);
  });

  it('COMPLETE DENTISTRY: an exhausted personal chain becomes a fallback candidate and resolves through the existing published fact', () => {
    const { fallbackCandidates, selected } = selectResolveBatchTargets(
      [lead()],
      {
        durablyQualifiedLeadIds: new Set(['complete-dentistry']),
        officialDomainByLead: new Map([['complete-dentistry', DOMAIN]]),
        candidatesByLead: new Map([['complete-dentistry', CANDIDATES]]),
        existingResultsByLead: new Map([['complete-dentistry', exhaustedChain()]]),
        maxOpportunityScoreByLead: new Map(),
        availableProviders: BOTH,
      },
      { limit: 10 },
    );
    // No provider work is offered (nothing left to try) ...
    expect(selected).toEqual([]);
    expect(fallbackCandidates).toHaveLength(1);
    expect(fallbackCandidates[0]?.domain).toBe(DOMAIN);

    // ... and the deterministic fallback resolves it with zero provider calls and zero credits.
    const decision = evaluateOfficialInboxFallback(fallbackCandidates[0]?.domain ?? null, fact());
    expect(decision.accepted).toBe(true);
  });

  it('COMPLETE DENTISTRY with NO stored contact_email fact stays UNRESOLVED — nothing is guessed', () => {
    const decision = evaluateOfficialInboxFallback(DOMAIN, null);
    expect(decision).toEqual({ accepted: false, reason: 'no_contact_email_fact' });
  });
});

describe('intended decision-makers', () => {
  it('carries names in priority order for a FORWARDING request, never as mailbox ownership', () => {
    expect(toIntendedDecisionMakers(CANDIDATES)).toEqual([
      { fullName: 'Richard Clarke-Irons', title: 'Principal Dentist', priority: 1 },
      { fullName: 'Sarah Lowe', title: 'Practice Manager', priority: 2 },
    ]);
  });

  it('the accepted generic decision itself contains no person field at all', () => {
    const d = evaluateOfficialInboxFallback(DOMAIN, fact());
    expect(d.accepted).toBe(true);
    // The resolved shape carries an address + provenance only. There is no name/title key that a
    // downstream consumer could mistake for "this mailbox belongs to X".
    if (d.accepted) expect(Object.keys(d).sort()).toEqual(['accepted', 'email', 'normalizedLocalPart', 'sourceFactId', 'sourceUrl']);
  });
});

describe('the fallback spends nothing', () => {
  it('is a pure function of already-stored data: no provider, no client, no credit', () => {
    // evaluateOfficialInboxFallback takes ONLY a domain string and a stored fact. It has no provider
    // parameter and no injected client, so there is no seam through which a credit could be spent.
    expect(evaluateOfficialInboxFallback.length).toBe(2);
    const input = fact();
    const before = JSON.stringify(input);
    evaluateOfficialInboxFallback(DOMAIN, input);
    expect(JSON.stringify(input)).toBe(before); // and it mutates nothing
  });

  it('does not disturb existing Instantly/Hunter idempotency hashes', () => {
    // The fallback never participates in computeInputHash; the personal cascade's identity is
    // unchanged by this feature.
    expect(computeInputHash('ENRICH', 'instantly', DOMAIN, CANDIDATES)).toBe(computeInputHash('ENRICH', 'instantly', DOMAIN, CANDIDATES));
    expect(computeInputHash('ENRICH', 'hunter', DOMAIN, CANDIDATES)).not.toBe(computeInputHash('ENRICH', 'instantly', DOMAIN, CANDIDATES));
  });
});
