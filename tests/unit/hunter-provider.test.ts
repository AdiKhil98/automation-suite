import { describe, it, expect } from 'vitest';
import { type Logger } from 'pino';
import { ContactEnrichmentService, type ContactEnrichmentStore, type EnrichmentRunCaps } from '../../src/domain/contact-enrichment/service.js';
import { type CandidatePerson, type ContactEnrichmentResult, type EnrichmentMode } from '../../src/domain/contact-enrichment/types.js';
import { HunterContactEnrichmentProvider, type FetchLike } from '../../src/integrations/contact-enrichment/hunter-provider.js';
import { buildEmailFinderParams, buildEmailVerifierParams, normalizeHunterVerification } from '../../src/integrations/contact-enrichment/hunter-schema.js';

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;
const caps: EnrichmentRunCaps = { maxRequests: 3, maxCredits: 3, minCreditsPerLookup: 1 };
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
  save(result: ContactEnrichmentResult): Promise<void> { this.rows.push(result); return Promise.resolve(); }
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
});
