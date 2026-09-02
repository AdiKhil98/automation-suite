import { describe, it, expect } from 'vitest';
import { type Logger } from 'pino';
import { ContactEnrichmentService, type ContactEnrichmentStore, type EnrichmentRunCaps } from '../../src/domain/contact-enrichment/service.js';
import { type CandidatePerson, type ContactEnrichmentResult, type EnrichmentMode } from '../../src/domain/contact-enrichment/types.js';
import { HunterContactEnrichmentProvider, type FetchLike } from '../../src/integrations/contact-enrichment/hunter-provider.js';
import { MockContactEnrichmentProvider } from '../../src/integrations/contact-enrichment/mock-provider.js';
import {
  buildDomainSearchParams,
  buildEmailFinderParams,
  buildEmailVerifierParams,
  classifyDomainSearchEmail,
  estimateDomainSearchCredits,
  extractDomainSearchPeople,
  hunterDomainSearchResponseSchema,
  normalizeHunterVerification,
} from '../../src/integrations/contact-enrichment/hunter-schema.js';

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;
const caps: EnrichmentRunCaps = { maxRequests: 3, maxCredits: 3, minCreditsPerLookup: 1 };
// 3 known candidates -> 3 Finder requests; Domain Search is a 4th HTTP call, so maxRequests must
// leave room for it (this mirrors the real recommended canary caps: MAX_REQUESTS=4).
const dsCaps: EnrichmentRunCaps = { maxRequests: 4, maxCredits: 3, minCreditsPerLookup: 1 };
const DOMAIN = 'diamond-smile.com';

function person(name: string, title: string, priority: number): CandidatePerson {
  const t = name.split(/\s+/);
  return { fullName: name, firstName: t[0] ?? name, lastName: t[t.length - 1] ?? name, title, priority };
}
const CANDIDATES: CandidatePerson[] = [
  person('Shyam Shastri', 'Principal Dentist', 1),
  person('Shaimil Patel', 'Clinical Director', 2),
  person('Kymya Doyley', 'Practice Manager', 3),
];

class MemStore implements ContactEnrichmentStore {
  rows: ContactEnrichmentResult[] = [];
  findByInputHash(leadId: string, provider: string, mode: EnrichmentMode, inputHash: string): Promise<ContactEnrichmentResult | null> {
    return Promise.resolve(this.rows.find((r) => r.leadId === leadId && r.provider === provider && r.mode === mode && r.inputHash === inputHash) ?? null);
  }
  save(result: ContactEnrichmentResult, opts?: { overwrite?: boolean }): Promise<void> {
    if (opts?.overwrite) {
      const i = this.rows.findIndex((r) => r.leadId === result.leadId && r.provider === result.provider && r.mode === result.mode && r.inputHash === result.inputHash);
      if (i >= 0) { this.rows[i] = result; return Promise.resolve(); }
    }
    this.rows.push(result);
    return Promise.resolve();
  }
}

function fakeFetch(seq: Array<{ ok?: boolean; status?: number; body: unknown }>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  let i = 0;
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string> });
    const r = seq[Math.min(i, seq.length - 1)]; i += 1;
    return Promise.resolve({ ok: r.ok ?? true, status: r.status ?? 200, text: () => Promise.resolve(JSON.stringify(r.body)) } as unknown as Response);
  }) as unknown as FetchLike;
  return { fetchImpl, calls };
}
function provider(fetchImpl: FetchLike, allowPaidEnrichment = true) {
  return new HunterContactEnrichmentProvider({
    apiKey: 'hunter-secret-key', baseUrl: 'https://api.hunter.io/v2', timeoutMs: 5000, allowPaidEnrichment, logger, fetchImpl,
  });
}
const q = { domain: DOMAIN, fullName: 'Shyam Shastri', firstName: 'Shyam', lastName: 'Shastri', title: 'Principal Dentist' };

describe('Hunter provider — preview (zero-network echo)', () => {
  it('makes ZERO fetch calls and echoes the given candidates back as PreviewPerson', async () => {
    const { fetchImpl, calls } = fakeFetch([{ body: {} }]);
    const r = await provider(fetchImpl).preview(DOMAIN, CANDIDATES);
    expect(calls).toHaveLength(0);
    expect(r.people).toHaveLength(3);
    expect(r.people[0]).toMatchObject({ firstName: 'Shyam', lastName: 'Shastri', domain: DOMAIN, title: 'Principal Dentist' });
    expect(r.creditsReported).toBeNull();
  });
  it('defaults to an empty echo when no candidates are given', async () => {
    const { fetchImpl, calls } = fakeFetch([{ body: {} }]);
    const r = await provider(fetchImpl).preview(DOMAIN);
    expect(calls).toHaveLength(0);
    expect(r.people).toHaveLength(0);
  });
});

describe('Hunter provider — enrich (Finder first; Verifier only when genuinely ambiguous)', () => {
  it('Finder returns no email -> NOT_FOUND, Verifier is NEVER called, 0 credits (free per Hunter docs)', async () => {
    const { fetchImpl, calls } = fakeFetch([{ body: { data: { email: null } } }]);
    const r = await provider(fetchImpl).enrich(q);
    expect(r.verificationStatus).toBe('NOT_FOUND');
    expect(r.email).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/email-finder');
    expect(calls[0].headers.Authorization).toBe('Bearer hunter-secret-key');
    expect(r.requestsUsed).toBe(1);
    expect(r.creditsUsed).toBe(0);
  });
  it('Finder verification is clearly valid -> VERIFIED directly, Verifier NEVER called (saves the extra credit)', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { body: { data: { email: `shyam@${DOMAIN}`, first_name: 'Shyam', last_name: 'Shastri', domain: DOMAIN, position: 'Principal Dentist', score: 90, accept_all: false, verification: { status: 'valid' } } } },
    ]);
    const r = await provider(fetchImpl).enrich(q);
    expect(calls).toHaveLength(1); // Finder alone — Verifier never called
    expect(calls[0].url).toContain('/email-finder');
    expect(r.verificationStatus).toBe('VERIFIED');
    expect(r.email).toBe(`shyam@${DOMAIN}`);
    expect(r.returnedIdentity).toMatchObject({ firstName: 'Shyam', lastName: 'Shastri', title: 'Principal Dentist' });
    expect(r.confidence).toBeCloseTo(0.9);
    expect(r.creditsReported).toBeNull(); // Hunter responses carry no credit-count field — never fabricated
    expect(r.requestsUsed).toBe(1);
    expect(r.creditsUsed).toBe(1);
  });
  it('Finder verification is clearly accept_all -> CATCH_ALL directly, Verifier NEVER called', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { body: { data: { email: `info@${DOMAIN}`, accept_all: true, verification: { status: 'accept_all' } } } },
    ]);
    const r = await provider(fetchImpl).enrich(q);
    expect(calls).toHaveLength(1);
    expect(r.verificationStatus).toBe('CATCH_ALL');
    expect(r.requestsUsed).toBe(1);
    expect(r.creditsUsed).toBe(1);
  });
  it('Finder verification is ambiguous (unknown) -> a SEPARATE Verifier call is genuinely needed', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { body: { data: { email: `shyam@${DOMAIN}`, first_name: 'Shyam', last_name: 'Shastri', domain: DOMAIN, position: 'Principal Dentist', score: 80, accept_all: false, verification: { status: 'unknown' } } } },
      { body: { data: { status: 'valid', result: 'deliverable', accept_all: false, block: false } } },
    ]);
    const r = await provider(fetchImpl).enrich(q);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain('/email-verifier');
    expect(calls[1].url).toContain(encodeURIComponent(`shyam@${DOMAIN}`));
    expect(r.verificationStatus).toBe('VERIFIED');
    expect(r.requestsUsed).toBe(2);
    expect(r.creditsUsed).toBe(2);
  });
  it('Finder verification missing entirely -> treated as ambiguous, Verifier is called', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { body: { data: { email: `shyam@${DOMAIN}`, accept_all: false } } }, // no `verification` object at all
      { body: { data: { status: 'invalid', result: 'undeliverable', accept_all: false } } },
    ]);
    const r = await provider(fetchImpl).enrich(q);
    expect(calls).toHaveLength(2);
    expect(r.verificationStatus).toBe('INVALID');
    expect(r.requestsUsed).toBe(2);
    expect(r.creditsUsed).toBe(2);
  });
  it('rejects fail-closed on every non-clean Verifier signal, reached via an ambiguous Finder verification', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ status: 'accept_all', result: 'deliverable', accept_all: true }, 'CATCH_ALL'],
      [{ status: 'unknown', result: 'risky', accept_all: false }, 'RISKY'],
      [{ status: 'invalid', result: 'undeliverable', accept_all: false }, 'INVALID'],
      [{ status: 'valid', result: 'deliverable', accept_all: false, block: true }, 'INVALID'],
      [{ status: 'valid', result: 'deliverable', accept_all: false, disposable: true }, 'INVALID'],
      [{ status: 'webmail', result: 'deliverable', accept_all: false }, 'UNKNOWN'],
      [{}, 'UNKNOWN'],
    ];
    for (const [verifierBody, expected] of cases) {
      const { fetchImpl } = fakeFetch([
        { body: { data: { email: `shyam@${DOMAIN}`, accept_all: false, verification: { status: 'unknown' } } } },
        { body: { data: verifierBody } },
      ]);
      const r = await provider(fetchImpl).enrich(q);
      expect(r.verificationStatus).toBe(expected);
    }
  });
  it('fails closed without ALLOW_PAID_ENRICHMENT_CALLS — before any fetch call', async () => {
    const { fetchImpl, calls } = fakeFetch([{ body: {} }]);
    await expect(provider(fetchImpl, false).enrich(q)).rejects.toMatchObject({ code: 'ENRICHMENT_PROVIDER_NOT_ALLOWED' });
    expect(calls).toHaveLength(0);
  });
  it('builds Finder params from domain/first_name/last_name (no title) and Verifier params from email only', () => {
    expect(Object.fromEntries(buildEmailFinderParams(q))).toEqual({ domain: DOMAIN, first_name: 'Shyam', last_name: 'Shastri' });
    expect(Object.fromEntries(buildEmailVerifierParams(`shyam@${DOMAIN}`))).toEqual({ email: `shyam@${DOMAIN}` });
  });
  it('normalizeHunterVerification: block/disposable win over an otherwise-clean status', () => {
    expect(normalizeHunterVerification({ status: 'valid', result: 'deliverable', score: 90, acceptAll: false, block: true, webmail: false, disposable: false })).toBe('INVALID');
    expect(normalizeHunterVerification({ status: 'valid', result: 'deliverable', score: 90, acceptAll: false, block: false, webmail: false, disposable: true })).toBe('INVALID');
  });
});

describe('Hunter provider — domainSearch (final fallback, at most once, after all Finder attempts fail)', () => {
  it('builds domain-search params from domain alone (no name/title filter)', () => {
    expect(Object.fromEntries(buildDomainSearchParams(DOMAIN))).toEqual({ domain: DOMAIN });
  });
  it('parses the official response shape: personal vs generic type, bundled per-email verification', async () => {
    const { fetchImpl, calls } = fakeFetch([{
      body: {
        data: {
          domain: DOMAIN, accept_all: false,
          emails: [
            { value: `shaimil@${DOMAIN}`, type: 'personal', confidence: 92, first_name: 'Shaimil', last_name: 'Patel', position: 'Clinical Director', verification: { status: 'valid' } },
            { value: `info@${DOMAIN}`, type: 'generic', confidence: 50, verification: { status: 'unknown' } },
          ],
        },
      },
    }]);
    const r = await provider(fetchImpl).domainSearch(DOMAIN);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/domain-search');
    expect(calls[0].url).toContain(`domain=${DOMAIN}`);
    expect(r.people).toHaveLength(2);
    expect(r.people[0]).toMatchObject({ email: `shaimil@${DOMAIN}`, emailType: 'personal', firstName: 'Shaimil', lastName: 'Patel', title: 'Clinical Director', verificationStatus: 'VERIFIED' });
    expect(r.people[1]).toMatchObject({ email: `info@${DOMAIN}`, emailType: 'generic', verificationStatus: 'UNKNOWN' });
    expect(r.creditsUsed).toBe(1); // at least one result was returned
    expect(r.creditsReported).toBeNull();
  });
  it('a whole-domain catch-all flag rejects EVERY email on it regardless of its own bundled verification', () => {
    expect(classifyDomainSearchEmail(true, 'valid')).toBe('CATCH_ALL');
    expect(classifyDomainSearchEmail(false, 'valid')).toBe('VERIFIED');
    expect(classifyDomainSearchEmail(false, 'accept_all')).toBe('CATCH_ALL');
    expect(classifyDomainSearchEmail(false, 'unknown')).toBe('UNKNOWN');
    expect(classifyDomainSearchEmail(null, null)).toBe('UNKNOWN');
  });
  it('zero results -> 0 credits, empty people, fail-closed (no crash)', async () => {
    const { fetchImpl } = fakeFetch([{ body: { data: { domain: DOMAIN, accept_all: false, emails: [] } } }]);
    const r = await provider(fetchImpl).domainSearch(DOMAIN);
    expect(r.people).toHaveLength(0);
    expect(r.creditsUsed).toBe(0);
  });
  it('fails closed without ALLOW_PAID_ENRICHMENT_CALLS — before any fetch call', async () => {
    const { fetchImpl, calls } = fakeFetch([{ body: {} }]);
    await expect(provider(fetchImpl, false).domainSearch(DOMAIN)).rejects.toMatchObject({ code: 'ENRICHMENT_PROVIDER_NOT_ALLOWED' });
    expect(calls).toHaveLength(0);
  });
  it('extractDomainSearchPeople skips an entry with no email value', () => {
    const parsed = hunterDomainSearchResponseSchema.parse({ data: { accept_all: false, emails: [{ type: 'personal' }, { value: `a@${DOMAIN}`, type: 'personal' }] } });
    expect(extractDomainSearchPeople(parsed, DOMAIN)).toHaveLength(1);
  });
});

describe('Hunter as fallback provider #2 — full pipeline via ContactEnrichmentService', () => {
  it('PREVIEW mode: zero network calls, all 3 candidates trivially matched (already known from the website)', async () => {
    const { fetchImpl, calls } = fakeFetch([{ body: {} }]);
    const service = new ContactEnrichmentService({ provider: provider(fetchImpl), store: new MemStore(), logger });
    const r = await service.run('l', DOMAIN, CANDIDATES, caps, { performEnrichment: false });
    expect(r.outcome).toBe('PREVIEW_MATCHED');
    expect(r.mode).toBe('PREVIEW');
    expect(r.creditsEstimated).toBe(0);
    expect(calls).toHaveLength(0);
  });
  it('ENRICH mode: stops at the first VERIFIED candidate; Finder-only accept never spends a Verifier credit (Shastri has no email, Patel is verified by Finder alone, Doyley never attempted)', async () => {
    const fetchImpl = ((url: string) => {
      if (url.includes('first_name=Shyam')) {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ data: { email: null } })) } as unknown as Response);
      }
      if (url.includes('first_name=Shaimil') && url.includes('/email-finder')) {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ data: { email: `shaimil@${DOMAIN}`, first_name: 'Shaimil', last_name: 'Patel', domain: DOMAIN, position: 'Clinical Director', score: 95, accept_all: false, verification: { status: 'valid' } } })) } as unknown as Response);
      }
      throw new Error(`unexpected Hunter call (expected only 2 Finder calls, no Verifier, no Doyley call): ${url}`);
    }) as unknown as FetchLike;
    const service = new ContactEnrichmentService({ provider: provider(fetchImpl), store: new MemStore(), logger });
    const r = await service.run('l', DOMAIN, CANDIDATES, caps, { performEnrichment: true });
    expect(r.outcome).toBe('VERIFIED');
    expect(r.mode).toBe('ENRICH');
    expect(r.accepted?.fullName).toBe('Shaimil Patel');
    expect(r.accepted?.email).toBe(`shaimil@${DOMAIN}`);
    // Shastri: 1 Finder call, 0 credit (no email). Patel: 1 Finder call, 1 credit (Finder-only accept, no Verifier).
    expect(r.creditsEstimated).toBe(1);
    expect((r.provenance as { requestsUsed?: number }).requestsUsed).toBe(2);
  });
  it('ENRICH mode: request/credit caps reflect actual HTTP calls, not one-per-attempt — an ambiguous Finder verification costs 2', async () => {
    const fetchImpl = ((url: string) => {
      if (url.includes('first_name=Shyam') && url.includes('/email-finder')) {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ data: { email: null } })) } as unknown as Response);
      }
      if (url.includes('first_name=Shaimil') && url.includes('/email-finder')) {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ data: { email: `shaimil@${DOMAIN}`, first_name: 'Shaimil', last_name: 'Patel', domain: DOMAIN, position: 'Clinical Director', score: 70, accept_all: false, verification: { status: 'unknown' } } })) } as unknown as Response);
      }
      if (url.includes('/email-verifier')) {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ data: { status: 'valid', result: 'deliverable', accept_all: false, block: false } })) } as unknown as Response);
      }
      throw new Error(`unexpected Hunter call: ${url}`);
    }) as unknown as FetchLike;
    const service = new ContactEnrichmentService({ provider: provider(fetchImpl), store: new MemStore(), logger });
    const r = await service.run('l', DOMAIN, CANDIDATES, caps, { performEnrichment: true });
    expect(r.outcome).toBe('VERIFIED');
    expect(r.accepted?.fullName).toBe('Shaimil Patel');
    // Shastri: 1 request, 0 credit. Patel: Finder (ambiguous) + Verifier = 2 requests, 2 credits.
    expect(r.creditsEstimated).toBe(2);
    expect((r.provenance as { requestsUsed?: number }).requestsUsed).toBe(3);
  });

  function allFinderMiss(extra?: { url: string; body: unknown }) {
    return ((url: string) => {
      if (url.includes('/email-finder')) {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ data: { email: null } })) } as unknown as Response);
      }
      if (extra && url.includes(extra.url)) {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(extra.body)) } as unknown as Response);
      }
      throw new Error(`unexpected Hunter call: ${url}`);
    }) as unknown as FetchLike;
  }

  it('Finder fails for all 3 candidates -> Domain Search runs ONCE -> exact-match acceptance', async () => {
    const fetchImpl = allFinderMiss({
      url: '/domain-search',
      body: {
        data: {
          domain: DOMAIN, accept_all: false,
          emails: [{ value: `shaimil@${DOMAIN}`, type: 'personal', confidence: 92, first_name: 'Shaimil', last_name: 'Patel', position: 'Clinical Director', verification: { status: 'valid' } }],
        },
      },
    });
    const service = new ContactEnrichmentService({ provider: provider(fetchImpl), store: new MemStore(), logger });
    const r = await service.run('l', DOMAIN, CANDIDATES, dsCaps, { performEnrichment: true });
    expect(r.outcome).toBe('VERIFIED');
    expect(r.accepted?.fullName).toBe('Shaimil Patel');
    expect(r.accepted?.email).toBe(`shaimil@${DOMAIN}`);
    const dsProv = (r.provenance as { domainSearch?: { peopleCount?: number } }).domainSearch;
    expect(dsProv?.peopleCount).toBe(1);
    // 3 Finder NOT_FOUND (0 credit each) + Domain Search returning 1 email (1-10 tier -> 1 credit).
    expect(r.creditsEstimated).toBe(1);
  });

  it('unrelated-person rejection: Domain Search returns only people who match none of our candidates -> stays NOT_FOUND, still only ONE Domain Search call', async () => {
    const fetchImpl = allFinderMiss({
      url: '/domain-search',
      body: {
        data: {
          domain: DOMAIN, accept_all: false,
          emails: [{ value: `someone.else@${DOMAIN}`, type: 'personal', first_name: 'Someone', last_name: 'Else', position: 'Receptionist', verification: { status: 'valid' } }],
        },
      },
    });
    const service = new ContactEnrichmentService({ provider: provider(fetchImpl), store: new MemStore(), logger });
    const r = await service.run('l', DOMAIN, CANDIDATES, dsCaps, { performEnrichment: true });
    expect(r.outcome).toBe('NOT_FOUND');
    expect(r.accepted).toBeNull();
  });

  it('generic-email rejection: Domain Search matches a candidate by name but the email is generic (info@) -> rejected, stays NOT_FOUND', async () => {
    const fetchImpl = allFinderMiss({
      url: '/domain-search',
      body: {
        data: {
          domain: DOMAIN, accept_all: false,
          // Matches Shyam Shastri by name/title, but the email itself is a generic role mailbox.
          emails: [{ value: `info@${DOMAIN}`, type: 'personal', first_name: 'Shyam', last_name: 'Shastri', position: 'Principal Dentist', verification: { status: 'valid' } }],
        },
      },
    });
    const service = new ContactEnrichmentService({ provider: provider(fetchImpl), store: new MemStore(), logger });
    const r = await service.run('l', DOMAIN, CANDIDATES, dsCaps, { performEnrichment: true });
    expect(r.outcome).toBe('NOT_FOUND');
    expect(r.accepted).toBeNull();
    const dsProv = (r.provenance as { domainSearch?: { attempts?: Array<{ reason?: string }> } }).domainSearch;
    expect(dsProv?.attempts?.some((a) => a.reason === 'generic_mailbox_rejected')).toBe(true);
  });

  it('Domain Search empty result -> 0 estimated credits (no-result fail-closed, no crash)', async () => {
    const fetchImpl = allFinderMiss({ url: '/domain-search', body: { data: { domain: DOMAIN, accept_all: false, emails: [] } } });
    const service = new ContactEnrichmentService({ provider: provider(fetchImpl), store: new MemStore(), logger });
    const r = await service.run('l', DOMAIN, CANDIDATES, dsCaps, { performEnrichment: true });
    expect(r.outcome).toBe('NOT_FOUND');
    // 3 Finder misses (0 credit each) + Domain Search with 0 results (0 credit) = 0 total.
    expect(r.creditsEstimated).toBe(0);
  });

  it('Domain Search returning 1-10 emails -> 1 estimated credit (Hunter pricing tier)', async () => {
    const fetchImpl = allFinderMiss({
      url: '/domain-search',
      body: {
        data: {
          domain: DOMAIN, accept_all: false,
          emails: [
            { value: `a1@${DOMAIN}`, type: 'generic' },
            { value: `a2@${DOMAIN}`, type: 'generic' },
            { value: `a3@${DOMAIN}`, type: 'generic' },
          ],
        },
      },
    });
    const service = new ContactEnrichmentService({ provider: provider(fetchImpl), store: new MemStore(), logger });
    const r = await service.run('l', DOMAIN, CANDIDATES, dsCaps, { performEnrichment: true });
    expect(r.outcome).toBe('NOT_FOUND'); // none of these are personal-typed / match a candidate
    expect(r.creditsEstimated).toBe(1); // 3 emails returned -> still within the 1-10 tier -> 1 credit
  });

  it('estimateDomainSearchCredits: 0 for no results, 1 for the 1-10 tier, 2 once past 10', () => {
    expect(estimateDomainSearchCredits(0)).toBe(0);
    expect(estimateDomainSearchCredits(1)).toBe(1);
    expect(estimateDomainSearchCredits(10)).toBe(1);
    expect(estimateDomainSearchCredits(11)).toBe(2);
  });

  it('Domain Search still executes under a 2-credit cap when the 3 Finder attempts spent 0 credits', async () => {
    const twoCreditCaps: EnrichmentRunCaps = { maxRequests: 4, maxCredits: 2, minCreditsPerLookup: 1 };
    let domainSearchCalled = false;
    const fetchImpl = ((url: string) => {
      if (url.includes('/email-finder')) return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ data: { email: null } })) } as unknown as Response);
      if (url.includes('/domain-search')) {
        domainSearchCalled = true;
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ data: { domain: DOMAIN, accept_all: false, emails: [] } })) } as unknown as Response);
      }
      throw new Error(`unexpected Hunter call: ${url}`);
    }) as unknown as FetchLike;
    const service = new ContactEnrichmentService({ provider: provider(fetchImpl), store: new MemStore(), logger });
    const r = await service.run('l', DOMAIN, CANDIDATES, twoCreditCaps, { performEnrichment: true });
    expect(domainSearchCalled).toBe(true);
    expect(r.outcome).toBe('NOT_FOUND'); // reached and completed Domain Search, found nothing — not capped
  });

  it('3 Finder NOT_FOUND calls consume exactly 3 requests / 0 estimated credits, and the request cap stops before Domain Search when fewer than 4 HTTP requests are allowed', async () => {
    let domainSearchCalled = false;
    const fetchImpl = ((url: string) => {
      if (url.includes('/email-finder')) return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ data: { email: null } })) } as unknown as Response);
      if (url.includes('/domain-search')) { domainSearchCalled = true; }
      throw new Error(`unexpected Hunter call: ${url}`);
    }) as unknown as FetchLike;
    const service = new ContactEnrichmentService({ provider: provider(fetchImpl), store: new MemStore(), logger });
    const r = await service.run('l', DOMAIN, CANDIDATES, caps, { performEnrichment: true }); // caps.maxRequests = 3
    expect(r.outcome).toBe('CAPPED'); // blocked at the Domain Search request gate, not any Finder failure
    expect(r.creditsEstimated).toBe(0); // all 3 Finder attempts were NOT_FOUND (0 credit each)
    expect(domainSearchCalled).toBe(false);
    expect((r.provenance as { requestsUsed?: number }).requestsUsed).toBe(3);
  });

  it('idempotency: repeating the exact same ENRICH run does not call Domain Search (or Finder) again', async () => {
    let domainSearchCalls = 0;
    const fetchImpl = ((url: string) => {
      if (url.includes('/email-finder')) return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ data: { email: null } })) } as unknown as Response);
      if (url.includes('/domain-search')) {
        domainSearchCalls += 1;
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ data: { domain: DOMAIN, accept_all: false, emails: [] } })) } as unknown as Response);
      }
      throw new Error(`unexpected Hunter call: ${url}`);
    }) as unknown as FetchLike;
    const store = new MemStore();
    const service = new ContactEnrichmentService({ provider: provider(fetchImpl), store, logger });
    const r1 = await service.run('l', DOMAIN, CANDIDATES, dsCaps, { performEnrichment: true });
    const r2 = await service.run('l', DOMAIN, CANDIDATES, dsCaps, { performEnrichment: true });
    expect(r2.id).toBe(r1.id);
    expect(domainSearchCalls).toBe(1); // only the first run actually reached Domain Search
  });

  it('force-refresh bypasses a stale cached NOT_FOUND row and actually re-runs (including Domain Search)', async () => {
    const store = new MemStore();
    const staleFetch = allFinderMiss({ url: '/domain-search', body: { data: { domain: DOMAIN, accept_all: false, emails: [] } } });
    const staleService = new ContactEnrichmentService({ provider: provider(staleFetch), store, logger });
    const stale = await staleService.run('l', DOMAIN, CANDIDATES, dsCaps, { performEnrichment: true });
    expect(stale.outcome).toBe('NOT_FOUND');

    let domainSearchCalls = 0;
    const freshFetch = ((url: string) => {
      if (url.includes('/email-finder')) return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ data: { email: null } })) } as unknown as Response);
      if (url.includes('/domain-search')) {
        domainSearchCalls += 1;
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({
          data: { domain: DOMAIN, accept_all: false, emails: [{ value: `shaimil@${DOMAIN}`, type: 'personal', first_name: 'Shaimil', last_name: 'Patel', position: 'Clinical Director', verification: { status: 'valid' } }] },
        })) } as unknown as Response);
      }
      throw new Error(`unexpected Hunter call: ${url}`);
    }) as unknown as FetchLike;
    const freshService = new ContactEnrichmentService({ provider: provider(freshFetch), store, logger });
    const fresh = await freshService.run('l', DOMAIN, CANDIDATES, dsCaps, { performEnrichment: true, forceRefresh: true });
    expect(fresh.outcome).toBe('VERIFIED');
    expect(fresh.accepted?.email).toBe(`shaimil@${DOMAIN}`);
    expect(domainSearchCalls).toBe(1);
    expect(store.rows).toHaveLength(1); // overwritten in place, not appended as a second row
  });
});

describe('ContactEnrichmentService.runDomainSearchOnly — guarded Hunter-only canary (bypasses the Finder tier entirely)', () => {
  const dsOnlyCaps: EnrichmentRunCaps = { maxRequests: 1, maxCredits: 2, minCreditsPerLookup: 1 };

  it('accepts a matching candidate on the single Domain Search call; Finder is NEVER called', async () => {
    const fetchImpl = ((url: string) => {
      if (url.includes('/email-finder')) throw new Error(`Finder must never be called in domain-search-only mode: ${url}`);
      if (url.includes('/domain-search')) {
        return Promise.resolve({
          ok: true, status: 200,
          text: () => Promise.resolve(JSON.stringify({
            data: { domain: DOMAIN, accept_all: false, emails: [{ value: `shaimil@${DOMAIN}`, type: 'personal', first_name: 'Shaimil', last_name: 'Patel', position: 'Clinical Director', verification: { status: 'valid' } }] },
          })),
        } as unknown as Response);
      }
      throw new Error(`unexpected Hunter call: ${url}`);
    }) as unknown as FetchLike;
    const service = new ContactEnrichmentService({ provider: provider(fetchImpl), store: new MemStore(), logger });
    const r = await service.runDomainSearchOnly('l', DOMAIN, CANDIDATES, dsOnlyCaps, {});
    expect(r.mode).toBe('DOMAIN_SEARCH_ONLY');
    expect(r.outcome).toBe('VERIFIED');
    expect(r.accepted?.fullName).toBe('Shaimil Patel');
    expect(r.accepted?.email).toBe(`shaimil@${DOMAIN}`);
    expect((r.provenance as { requestsUsed?: number }).requestsUsed).toBe(1);
  });

  it('none of the known candidates match -> NOT_FOUND, still exactly one HTTP call', async () => {
    let calls = 0;
    const fetchImpl = ((url: string) => {
      if (url.includes('/email-finder')) throw new Error('Finder must never be called');
      calls += 1;
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ data: { domain: DOMAIN, accept_all: false, emails: [] } })) } as unknown as Response);
    }) as unknown as FetchLike;
    const service = new ContactEnrichmentService({ provider: provider(fetchImpl), store: new MemStore(), logger });
    const r = await service.runDomainSearchOnly('l', DOMAIN, CANDIDATES, dsOnlyCaps, {});
    expect(r.outcome).toBe('NOT_FOUND');
    expect(r.accepted).toBeNull();
    expect(calls).toBe(1);
  });

  it('rejects a matched generic mailbox (info@) even though the name/title matches', async () => {
    const fetchImpl = ((url: string) => {
      if (url.includes('/domain-search')) {
        return Promise.resolve({
          ok: true, status: 200,
          text: () => Promise.resolve(JSON.stringify({
            data: { domain: DOMAIN, accept_all: false, emails: [{ value: `info@${DOMAIN}`, type: 'personal', first_name: 'Shyam', last_name: 'Shastri', position: 'Principal Dentist', verification: { status: 'valid' } }] },
          })),
        } as unknown as Response);
      }
      throw new Error(`unexpected Hunter call: ${url}`);
    }) as unknown as FetchLike;
    const service = new ContactEnrichmentService({ provider: provider(fetchImpl), store: new MemStore(), logger });
    const r = await service.runDomainSearchOnly('l', DOMAIN, CANDIDATES, dsOnlyCaps, {});
    expect(r.outcome).toBe('NOT_FOUND');
    const attempts = (r.provenance as { domainSearch?: { attempts?: Array<{ reason?: string }> } }).domainSearch?.attempts;
    expect(attempts?.some((a) => a.reason === 'generic_mailbox_rejected')).toBe(true);
  });

  it('rejects an unrelated person even when their email is verified and personal-typed', async () => {
    const fetchImpl = ((url: string) => {
      if (url.includes('/domain-search')) {
        return Promise.resolve({
          ok: true, status: 200,
          text: () => Promise.resolve(JSON.stringify({
            data: { domain: DOMAIN, accept_all: false, emails: [{ value: `someone.else@${DOMAIN}`, type: 'personal', first_name: 'Someone', last_name: 'Else', position: 'Receptionist', verification: { status: 'valid' } }] },
          })),
        } as unknown as Response);
      }
      throw new Error(`unexpected Hunter call: ${url}`);
    }) as unknown as FetchLike;
    const service = new ContactEnrichmentService({ provider: provider(fetchImpl), store: new MemStore(), logger });
    const r = await service.runDomainSearchOnly('l', DOMAIN, CANDIDATES, dsOnlyCaps, {});
    expect(r.outcome).toBe('NOT_FOUND');
    expect(r.accepted).toBeNull();
  });

  it('idempotency: repeating the exact same run does not call Domain Search again', async () => {
    let calls = 0;
    const fetchImpl = ((_url: string) => {
      calls += 1;
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ data: { domain: DOMAIN, accept_all: false, emails: [] } })) } as unknown as Response);
    }) as unknown as FetchLike;
    const store = new MemStore();
    const service = new ContactEnrichmentService({ provider: provider(fetchImpl), store, logger });
    const r1 = await service.runDomainSearchOnly('l', DOMAIN, CANDIDATES, dsOnlyCaps, {});
    const r2 = await service.runDomainSearchOnly('l', DOMAIN, CANDIDATES, dsOnlyCaps, {});
    expect(r2.id).toBe(r1.id);
    expect(calls).toBe(1);
  });

  it('a DOMAIN_SEARCH_ONLY row never satisfies (or is satisfied by) an ENRICH/PREVIEW idempotency check for the same lead/domain/candidates', async () => {
    const store = new MemStore();
    const fetchImpl = ((_url: string) => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ data: { domain: DOMAIN, accept_all: false, emails: [] } })) } as unknown as Response)) as unknown as FetchLike;
    const service = new ContactEnrichmentService({ provider: provider(fetchImpl), store, logger });
    const dsOnly = await service.runDomainSearchOnly('l', DOMAIN, CANDIDATES, dsOnlyCaps, {});
    expect(dsOnly.mode).toBe('DOMAIN_SEARCH_ONLY');
    const found = await store.findByInputHash('l', 'hunter', 'ENRICH', dsOnly.inputHash);
    expect(found).toBeNull();
  });

  it('caps: maxRequests=0 blocks the call before any fetch (fail-closed pre-check, CAPPED)', async () => {
    const { fetchImpl, calls } = fakeFetch([{ body: {} }]);
    const service = new ContactEnrichmentService({ provider: provider(fetchImpl), store: new MemStore(), logger });
    const r = await service.runDomainSearchOnly('l', DOMAIN, CANDIDATES, { maxRequests: 0, maxCredits: 2, minCreditsPerLookup: 1 }, {});
    expect(r.outcome).toBe('CAPPED');
    expect(calls).toHaveLength(0);
  });

  it('caps: maxCredits=0 blocks the call before any fetch (fail-closed pre-check, CAPPED)', async () => {
    const { fetchImpl, calls } = fakeFetch([{ body: {} }]);
    const service = new ContactEnrichmentService({ provider: provider(fetchImpl), store: new MemStore(), logger });
    const r = await service.runDomainSearchOnly('l', DOMAIN, CANDIDATES, { maxRequests: 1, maxCredits: 0, minCreditsPerLookup: 1 }, {});
    expect(r.outcome).toBe('CAPPED');
    expect(calls).toHaveLength(0);
  });

  it('fails closed for a provider that does not implement domainSearch (e.g. mock), zero calls', async () => {
    const mock = new MockContactEnrichmentProvider();
    const service = new ContactEnrichmentService({ provider: mock, store: new MemStore(), logger });
    await expect(service.runDomainSearchOnly('l', DOMAIN, CANDIDATES, dsOnlyCaps, {})).rejects.toMatchObject({ code: 'DOMAIN_SEARCH_NOT_SUPPORTED' });
  });

  it('force-refresh bypasses a stale cached row and re-runs (still exactly one HTTP call)', async () => {
    const store = new MemStore();
    const staleFetch = ((_url: string) => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ data: { domain: DOMAIN, accept_all: false, emails: [] } })) } as unknown as Response)) as unknown as FetchLike;
    const staleService = new ContactEnrichmentService({ provider: provider(staleFetch), store, logger });
    const stale = await staleService.runDomainSearchOnly('l', DOMAIN, CANDIDATES, dsOnlyCaps, {});
    expect(stale.outcome).toBe('NOT_FOUND');

    let freshCalls = 0;
    const freshFetch = ((_url: string) => {
      freshCalls += 1;
      return Promise.resolve({
        ok: true, status: 200,
        text: () => Promise.resolve(JSON.stringify({
          data: { domain: DOMAIN, accept_all: false, emails: [{ value: `shaimil@${DOMAIN}`, type: 'personal', first_name: 'Shaimil', last_name: 'Patel', position: 'Clinical Director', verification: { status: 'valid' } }] },
        })),
      } as unknown as Response);
    }) as unknown as FetchLike;
    const freshService = new ContactEnrichmentService({ provider: provider(freshFetch), store, logger });
    const fresh = await freshService.runDomainSearchOnly('l', DOMAIN, CANDIDATES, dsOnlyCaps, { forceRefresh: true });
    expect(fresh.outcome).toBe('VERIFIED');
    expect(freshCalls).toBe(1);
    expect(store.rows).toHaveLength(1);
  });
});
