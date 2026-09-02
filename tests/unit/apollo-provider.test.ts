import { describe, it, expect } from 'vitest';
import { type Logger } from 'pino';
import { ContactEnrichmentService, type ContactEnrichmentStore, type EnrichmentRunCaps } from '../../src/domain/contact-enrichment/service.js';
import { type CandidatePerson, type ContactEnrichmentResult, type EnrichmentMode } from '../../src/domain/contact-enrichment/types.js';
import { ApolloContactEnrichmentProvider, type FetchLike } from '../../src/integrations/contact-enrichment/apollo-provider.js';
import {
  apolloPersonMatchResponseSchema,
  buildPeopleMatchRequestBody,
  buildPeopleSearchRequestBody,
  extractApolloPerson,
  extractApolloPreviewPerson,
  normalizeApolloEmailStatus,
} from '../../src/integrations/contact-enrichment/apollo-schema.js';

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
  save(result: ContactEnrichmentResult): Promise<void> {
    this.rows.push(result);
    return Promise.resolve();
  }
}

function fakeFetch(seq: Array<{ ok?: boolean; status?: number; body: unknown }>) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
  let i = 0;
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined });
    const r = seq[Math.min(i, seq.length - 1)]; i += 1;
    return Promise.resolve({ ok: r.ok ?? true, status: r.status ?? 200, text: () => Promise.resolve(JSON.stringify(r.body)) } as unknown as Response);
  }) as unknown as FetchLike;
  return { fetchImpl, calls };
}
function provider(fetchImpl: FetchLike, allowPaidEnrichment = true) {
  return new ApolloContactEnrichmentProvider({
    apiKey: 'apollo-secret-key', baseUrl: 'https://api.apollo.io/api/v1', timeoutMs: 5000, previewLimit: 25, allowPaidEnrichment, logger, fetchImpl,
  });
}

describe('Apollo provider — schema helpers', () => {
  it('builds the People Search body from domain + limit only (no title filter, for recall)', () => {
    expect(buildPeopleSearchRequestBody(DOMAIN, 25)).toEqual({ q_organization_domains_list: [DOMAIN], page: 1, per_page: 25 });
  });
  it('builds a People Match body preferring the Apollo person id when present', () => {
    expect(buildPeopleMatchRequestBody({ domain: DOMAIN, fullName: 'Shaimil Patel', firstName: 'Shaimil', lastName: 'Patel', title: 'Clinical Director', providerLeadId: 'apid-1' }))
      .toEqual({ id: 'apid-1' });
  });
  it('falls back to name + domain when no provider id is available', () => {
    expect(buildPeopleMatchRequestBody({ domain: DOMAIN, fullName: 'Shaimil Patel', firstName: 'Shaimil', lastName: 'Patel', title: 'Clinical Director' }))
      .toEqual({ first_name: 'Shaimil', last_name: 'Patel', domain: DOMAIN });
  });
  it('normalizeApolloEmailStatus: verified accepts, guessed/unavailable/unknown fail closed', () => {
    expect(normalizeApolloEmailStatus('verified')).toBe('VERIFIED');
    expect(normalizeApolloEmailStatus('guessed')).toBe('RISKY');
    expect(normalizeApolloEmailStatus('unavailable')).toBe('NOT_FOUND');
    expect(normalizeApolloEmailStatus(null)).toBe('NOT_FOUND');
    expect(normalizeApolloEmailStatus('something-new')).toBe('UNKNOWN');
    expect(normalizeApolloEmailStatus('accept_all')).toBe('CATCH_ALL');
  });
  it('extractApolloPreviewPerson never reads an email field (structurally cannot leak a search placeholder)', () => {
    const row = { id: 'a1', first_name: 'Shaimil', last_name: 'Patel', name: 'Shaimil Patel', title: 'Clinical Director', email: 'email_not_unlocked@diamond-smile.com', organization: { primary_domain: DOMAIN } };
    const p = extractApolloPreviewPerson(row);
    expect(p).toEqual({ name: 'Shaimil Patel', firstName: 'Shaimil', lastName: 'Patel', domain: DOMAIN, title: 'Clinical Director', providerLeadId: 'a1' });
    expect('email' in p).toBe(false);
  });
  it('extractApolloPerson returns null when Apollo genuinely found nobody', () => {
    expect(extractApolloPerson(apolloPersonMatchResponseSchema.parse({ person: null }))).toBeNull();
    expect(extractApolloPerson(apolloPersonMatchResponseSchema.parse({}))).toBeNull();
  });
  it('extractApolloPerson throws APOLLO_SCHEMA_MISMATCH when a person is returned with no email field', () => {
    expect(() => extractApolloPerson(apolloPersonMatchResponseSchema.parse({ person: { id: 'x', first_name: 'A' } })))
      .toThrow(/APOLLO_SCHEMA_MISMATCH|no recognizable email/);
  });
});

describe('Apollo provider — preview (free People Search, 0 credits, no email revealed)', () => {
  it('is allowed even when paid enrichment is off, and never reveals an email', async () => {
    const { fetchImpl, calls } = fakeFetch([{
      body: { people: [{ id: 'a1', first_name: 'Shaimil', last_name: 'Patel', name: 'Shaimil Patel', title: 'Clinical Director', organization: { primary_domain: DOMAIN } }] },
    }]);
    const r = await provider(fetchImpl, false).preview(DOMAIN);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/mixed_people/api_search');
    expect(calls[0].headers['X-Api-Key']).toBe('apollo-secret-key');
    expect(calls[0].body).toEqual({ q_organization_domains_list: [DOMAIN], page: 1, per_page: 25 });
    expect(r.people).toHaveLength(1);
    expect(r.people[0]).toMatchObject({ firstName: 'Shaimil', lastName: 'Patel', domain: DOMAIN, title: 'Clinical Director', providerLeadId: 'a1' });
    expect(r.creditsReported).toBeNull();
  });
  it('empty search results -> empty people list, no crash', async () => {
    const { fetchImpl } = fakeFetch([{ body: { people: [] } }]);
    const r = await provider(fetchImpl).preview(DOMAIN);
    expect(r.people).toHaveLength(0);
  });
});

describe('Apollo as fallback provider #3 — full pipeline via ContactEnrichmentService', () => {
  it('People Search finds a known person -> local match, PREVIEW_MATCHED, zero Match calls', async () => {
    const { fetchImpl, calls } = fakeFetch([{
      body: { people: [{ id: 'a2', first_name: 'Shaimil', last_name: 'Patel', name: 'Shaimil Patel', title: 'Clinical Director', organization: { primary_domain: DOMAIN } }] },
    }]);
    const service = new ContactEnrichmentService({ provider: provider(fetchImpl), store: new MemStore(), logger });
    const r = await service.run('l', DOMAIN, CANDIDATES, caps, { performEnrichment: false });
    expect(r.outcome).toBe('PREVIEW_MATCHED');
    expect(r.mode).toBe('PREVIEW');
    expect(r.creditsEstimated).toBe(0);
    expect(calls).toHaveLength(1); // search only, no match call
  });

  it('People Search returns only unrelated people -> PREVIEW_NO_MATCH, zero Match calls', async () => {
    const { fetchImpl, calls } = fakeFetch([{
      body: { people: [{ id: 'a3', first_name: 'Someone', last_name: 'Else', name: 'Someone Else', title: 'Receptionist', organization: { primary_domain: DOMAIN } }] },
    }]);
    const service = new ContactEnrichmentService({ provider: provider(fetchImpl), store: new MemStore(), logger });
    const r = await service.run('l', DOMAIN, CANDIDATES, caps, { performEnrichment: true });
    expect(r.outcome).toBe('PREVIEW_NO_MATCH');
    expect(calls).toHaveLength(1);
  });

  it('People Search returns zero results -> fail closed, PREVIEW_NO_MATCH, zero enrichment attempted', async () => {
    const { fetchImpl, calls } = fakeFetch([{ body: { people: [] } }]);
    const service = new ContactEnrichmentService({ provider: provider(fetchImpl), store: new MemStore(), logger });
    const r = await service.run('l', DOMAIN, CANDIDATES, caps, { performEnrichment: true });
    expect(r.outcome).toBe('PREVIEW_NO_MATCH');
    expect(r.creditsEstimated).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('a matched candidate -> People Match called exactly once, preferring the Apollo person id from preview', async () => {
    const fetchImpl = ((url: string, init: RequestInit) => {
      if (url.includes('/mixed_people/api_search')) {
        return Promise.resolve({
          ok: true, status: 200,
          text: () => Promise.resolve(JSON.stringify({ people: [{ id: 'apid-77', first_name: 'Shaimil', last_name: 'Patel', name: 'Shaimil Patel', title: 'Clinical Director', organization: { primary_domain: DOMAIN } }] })),
        } as unknown as Response);
      }
      if (url.includes('/people/match')) {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        expect(body).toEqual({ id: 'apid-77' }); // prefers the id, never falls back to name+domain here
        return Promise.resolve({
          ok: true, status: 200,
          text: () => Promise.resolve(JSON.stringify({ person: { id: 'apid-77', first_name: 'Shaimil', last_name: 'Patel', name: 'Shaimil Patel', title: 'Clinical Director', email: `shaimil@${DOMAIN}`, email_status: 'verified', organization: { primary_domain: DOMAIN } } })),
        } as unknown as Response);
      }
      throw new Error(`unexpected Apollo call: ${url}`);
    }) as unknown as FetchLike;
    const service = new ContactEnrichmentService({ provider: provider(fetchImpl), store: new MemStore(), logger });
    const r = await service.run('l', DOMAIN, CANDIDATES, caps, { performEnrichment: true });
    expect(r.outcome).toBe('VERIFIED');
    expect(r.accepted?.fullName).toBe('Shaimil Patel');
    expect(r.accepted?.email).toBe(`shaimil@${DOMAIN}`);
  });

  it('falls back to name + domain when the matched preview row carried no Apollo id', async () => {
    const fetchImpl = ((url: string, init: RequestInit) => {
      if (url.includes('/mixed_people/api_search')) {
        return Promise.resolve({
          ok: true, status: 200,
          text: () => Promise.resolve(JSON.stringify({ people: [{ first_name: 'Shaimil', last_name: 'Patel', name: 'Shaimil Patel', title: 'Clinical Director', organization: { primary_domain: DOMAIN } }] })),
        } as unknown as Response);
      }
      if (url.includes('/people/match')) {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        expect(body).toEqual({ first_name: 'Shaimil', last_name: 'Patel', domain: DOMAIN });
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ person: null })) } as unknown as Response);
      }
      throw new Error(`unexpected Apollo call: ${url}`);
    }) as unknown as FetchLike;
    const service = new ContactEnrichmentService({ provider: provider(fetchImpl), store: new MemStore(), logger });
    const r = await service.run('l', DOMAIN, CANDIDATES, caps, { performEnrichment: true });
    expect(r.outcome).toBe('NOT_FOUND');
  });

  it('Match returns an unavailable/guessed email_status -> rejected, NOT_FOUND, no accepted contact', async () => {
    const fetchImpl = ((url: string) => {
      if (url.includes('/mixed_people/api_search')) {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ people: [{ id: 'a9', first_name: 'Shyam', last_name: 'Shastri', name: 'Shyam Shastri', title: 'Principal Dentist', organization: { primary_domain: DOMAIN } }] })) } as unknown as Response);
      }
      if (url.includes('/people/match')) {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ person: { id: 'a9', first_name: 'Shyam', last_name: 'Shastri', name: 'Shyam Shastri', title: 'Principal Dentist', email: `shyam@${DOMAIN}`, email_status: 'unavailable', organization: { primary_domain: DOMAIN } } })) } as unknown as Response);
      }
      throw new Error(`unexpected Apollo call: ${url}`);
    }) as unknown as FetchLike;
    const service = new ContactEnrichmentService({ provider: provider(fetchImpl), store: new MemStore(), logger });
    const r = await service.run('l', DOMAIN, CANDIDATES, caps, { performEnrichment: true });
    expect(r.outcome).toBe('NOT_FOUND');
    expect(r.accepted).toBeNull();
  });

  it('generic-mailbox rejection: name/title match but the email is a generic role mailbox -> rejected', async () => {
    const fetchImpl = ((url: string) => {
      if (url.includes('/mixed_people/api_search')) {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ people: [{ id: 'a5', first_name: 'Shyam', last_name: 'Shastri', name: 'Shyam Shastri', title: 'Principal Dentist', organization: { primary_domain: DOMAIN } }] })) } as unknown as Response);
      }
      if (url.includes('/people/match')) {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ person: { id: 'a5', first_name: 'Shyam', last_name: 'Shastri', name: 'Shyam Shastri', title: 'Principal Dentist', email: `info@${DOMAIN}`, email_status: 'verified', organization: { primary_domain: DOMAIN } } })) } as unknown as Response);
      }
      throw new Error(`unexpected Apollo call: ${url}`);
    }) as unknown as FetchLike;
    const service = new ContactEnrichmentService({ provider: provider(fetchImpl), store: new MemStore(), logger });
    const r = await service.run('l', DOMAIN, CANDIDATES, caps, { performEnrichment: true });
    expect(r.outcome).toBe('NOT_FOUND');
    const attempts = (r.provenance as { attempts?: Array<{ reason?: string }> }).attempts;
    expect(attempts?.some((a) => a.reason === 'generic_mailbox_rejected')).toBe(true);
  });

  it('idempotency: repeating the exact same run does not call Apollo again', async () => {
    let searchCalls = 0, matchCalls = 0;
    const fetchImpl = ((url: string) => {
      if (url.includes('/mixed_people/api_search')) {
        searchCalls += 1;
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ people: [{ id: 'a6', first_name: 'Shaimil', last_name: 'Patel', name: 'Shaimil Patel', title: 'Clinical Director', organization: { primary_domain: DOMAIN } }] })) } as unknown as Response);
      }
      if (url.includes('/people/match')) {
        matchCalls += 1;
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ person: { id: 'a6', first_name: 'Shaimil', last_name: 'Patel', name: 'Shaimil Patel', title: 'Clinical Director', email: `shaimil@${DOMAIN}`, email_status: 'verified', organization: { primary_domain: DOMAIN } } })) } as unknown as Response);
      }
      throw new Error(`unexpected Apollo call: ${url}`);
    }) as unknown as FetchLike;
    const store = new MemStore();
    const service = new ContactEnrichmentService({ provider: provider(fetchImpl), store, logger });
    const r1 = await service.run('l', DOMAIN, CANDIDATES, caps, { performEnrichment: true });
    const r2 = await service.run('l', DOMAIN, CANDIDATES, caps, { performEnrichment: true });
    expect(r2.id).toBe(r1.id);
    expect(searchCalls).toBe(1);
    expect(matchCalls).toBe(1);
  });

  it('request/credit caps: a cap sized to block the Match call -> CAPPED, zero Match calls', async () => {
    let matchCalled = false;
    const fetchImpl = ((url: string) => {
      if (url.includes('/mixed_people/api_search')) {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ people: [{ id: 'a7', first_name: 'Shaimil', last_name: 'Patel', name: 'Shaimil Patel', title: 'Clinical Director', organization: { primary_domain: DOMAIN } }] })) } as unknown as Response);
      }
      if (url.includes('/people/match')) { matchCalled = true; }
      throw new Error(`unexpected Apollo call: ${url}`);
    }) as unknown as FetchLike;
    const zeroReqCaps: EnrichmentRunCaps = { maxRequests: 0, maxCredits: 3, minCreditsPerLookup: 1 };
    const service = new ContactEnrichmentService({ provider: provider(fetchImpl), store: new MemStore(), logger });
    const r = await service.run('l', DOMAIN, CANDIDATES, zeroReqCaps, { performEnrichment: true });
    expect(r.outcome).toBe('CAPPED');
    expect(matchCalled).toBe(false);
  });

  it('fails closed without ALLOW_PAID_ENRICHMENT_CALLS — before any Match fetch call', async () => {
    const { fetchImpl, calls } = fakeFetch([{ body: {} }]);
    const q = { domain: DOMAIN, fullName: 'Shaimil Patel', firstName: 'Shaimil', lastName: 'Patel', title: 'Clinical Director' };
    await expect(provider(fetchImpl, false).enrich(q)).rejects.toMatchObject({ code: 'ENRICHMENT_PROVIDER_NOT_ALLOWED' });
    expect(calls).toHaveLength(0);
  });
});
