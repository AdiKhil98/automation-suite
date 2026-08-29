import { describe, it, expect, vi } from 'vitest';
import { type Logger } from 'pino';
import {
  ContactEnrichmentService,
  computeInputHash,
  type ContactEnrichmentStore,
  type EnrichmentRunCaps,
} from '../../src/domain/contact-enrichment/service.js';
import {
  type CandidatePerson,
  type ContactEnrichmentResult,
  type EnrichmentQuery,
  type EnrichmentVerificationStatus,
  type ProviderEnrichmentOutcome,
  type ReturnedIdentity,
} from '../../src/domain/contact-enrichment/types.js';
import { decideAcceptance, isGenericMailbox } from '../../src/domain/contact-enrichment/verification.js';
import { MockContactEnrichmentProvider } from '../../src/integrations/contact-enrichment/mock-provider.js';
import {
  InstantlyContactEnrichmentProvider,
  type FetchLike,
} from '../../src/integrations/contact-enrichment/instantly-provider.js';
import {
  buildEnrichLeadsRequestBody,
  buildLeadsListRequestBody,
  normalizeInstantlyVerification,
} from '../../src/integrations/contact-enrichment/instantly-schema.js';
import { buildContactEnrichmentProvider } from '../../src/cli/commands/contact-enrich-build.js';

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

function idFor(p: CandidatePerson, domain: string): ReturnedIdentity {
  return { name: p.fullName, firstName: p.firstName, lastName: p.lastName, domain, title: p.title };
}

function outcome(query: EnrichmentQuery, over: Partial<ProviderEnrichmentOutcome>): ProviderEnrichmentOutcome {
  return {
    query, email: null, returnedIdentity: null, verificationStatus: 'NOT_FOUND', dataQuality: null, confidence: null,
    creditsUsed: 1, resourceId: null, endpoint: 'mock://x', rawDigest: 'digest', ...over,
  };
}

class MemStore implements ContactEnrichmentStore {
  rows: ContactEnrichmentResult[] = [];
  findByInputHash(leadId: string, provider: string, inputHash: string): Promise<ContactEnrichmentResult | null> {
    return Promise.resolve(this.rows.find((r) => r.leadId === leadId && r.provider === provider && r.inputHash === inputHash) ?? null);
  }
  save(result: ContactEnrichmentResult): Promise<void> { this.rows.push(result); return Promise.resolve(); }
}

/** Verified + fully matching identity for the candidate whose lastName === forLast. */
function verifiedResponder(forLast: string) {
  return (q: EnrichmentQuery): ProviderEnrichmentOutcome => {
    if (q.lastName !== forLast) return outcome(q, { verificationStatus: 'NOT_FOUND', creditsUsed: 1 });
    return outcome(q, {
      email: `${q.firstName.toLowerCase()}@${q.domain}`, verificationStatus: 'VERIFIED', dataQuality: 'high', confidence: 0.98,
      creditsUsed: 1, resourceId: 'job', returnedIdentity: { name: q.fullName, firstName: q.firstName, lastName: q.lastName, domain: q.domain, title: q.title },
    });
  };
}

describe('contact-enrichment verification (trust boundary + identity match)', () => {
  const p = person('Shyam Shastri', 'Principal Dentist', 1);
  const q: EnrichmentQuery = { domain: DOMAIN, fullName: p.fullName, firstName: p.firstName, lastName: p.lastName, title: p.title };
  const good = { email: `shyam@${DOMAIN}`, verificationStatus: 'VERIFIED' as const, returnedIdentity: idFor(p, DOMAIN) };

  it('accepts a VERIFIED, non-generic, host-matching, identity-matching address', () => {
    const d = decideAcceptance(outcome(q, good), p, DOMAIN);
    expect(d.accepted).toBe(true);
    expect(d.contact?.email).toBe(`shyam@${DOMAIN}`);
    expect(d.match).toEqual({ name: true, domain: true, title: 'match' });
  });
  it('rejects non-verified statuses', () => {
    for (const s of ['RISKY', 'CATCH_ALL', 'INVALID', 'UNKNOWN'] as EnrichmentVerificationStatus[]) {
      expect(decideAcceptance(outcome(q, { ...good, verificationStatus: s }), p, DOMAIN).accepted).toBe(false);
    }
  });
  it('rejects a generic inbox even when verified', () => {
    expect(decideAcceptance(outcome(q, { ...good, email: `info@${DOMAIN}` }), p, DOMAIN).reason).toBe('generic_mailbox_rejected');
  });
  it('rejects when the email host does not match the requested domain', () => {
    expect(decideAcceptance(outcome(q, { ...good, email: 'shyam@other.com', returnedIdentity: { ...idFor(p, DOMAIN), domain: 'other.com' } }), p, DOMAIN).reason).toBe('domain_mismatch');
  });
  it('rejects when the returned person name does not match', () => {
    expect(decideAcceptance(outcome(q, { ...good, returnedIdentity: idFor(person('Someone Else', 'Principal Dentist', 1), DOMAIN) }), p, DOMAIN).reason).toBe('name_mismatch');
  });
  it('rejects when the returned title clearly conflicts', () => {
    expect(decideAcceptance(outcome(q, { ...good, returnedIdentity: { ...idFor(p, DOMAIN), title: 'Receptionist' } }), p, DOMAIN).reason).toBe('title_mismatch');
  });
  it('accepts when the title is absent (unconfirmed, not a mismatch)', () => {
    const d = decideAcceptance(outcome(q, { ...good, returnedIdentity: { ...idFor(p, DOMAIN), title: null } }), p, DOMAIN);
    expect(d.accepted).toBe(true);
    expect(d.match.title).toBe('unconfirmed');
  });
  it('rejects when there is no returned identity to validate', () => {
    expect(decideAcceptance(outcome(q, { email: `shyam@${DOMAIN}`, verificationStatus: 'VERIFIED', returnedIdentity: null }), p, DOMAIN).reason).toBe('no_returned_identity_to_validate');
  });
  it('classifies generic mailboxes', () => {
    for (const g of ['info@d.com', 'reception@d.com', 'bookings+london@d.com']) expect(isGenericMailbox(g)).toBe(true);
    expect(isGenericMailbox('shyam.shastri@d.com')).toBe(false);
  });
});

describe('contact-enrichment service', () => {
  function svc(responder: (q: EnrichmentQuery) => ProviderEnrichmentOutcome, store = new MemStore()) {
    const provider = new MockContactEnrichmentProvider(responder);
    const enrichSpy = vi.spyOn(provider, 'enrich');
    return { service: new ContactEnrichmentService({ provider, store, logger }), store, enrichSpy };
  }

  it('accepts the preferred candidate first and stops (1 request)', async () => {
    const { service, enrichSpy } = svc(verifiedResponder('Shastri'));
    const r = await service.run('lead1', DOMAIN, CANDIDATES, caps);
    expect(r.outcome).toBe('VERIFIED');
    expect(r.accepted?.fullName).toBe('Shyam Shastri');
    expect(r.accepted?.email).toBe(`shyam@${DOMAIN}`);
    expect(enrichSpy).toHaveBeenCalledTimes(1);
  });
  it('falls back in priority order when the preferred is not found', async () => {
    const { service, enrichSpy } = svc(verifiedResponder('Patel'));
    const r = await service.run('lead1', DOMAIN, CANDIDATES, caps);
    expect(r.accepted?.title).toBe('Clinical Director');
    expect(enrichSpy).toHaveBeenCalledTimes(2);
  });
  it('fails closed (NOT_FOUND) when nobody verifies', async () => {
    const { service } = svc((q) => outcome(q, { verificationStatus: 'NOT_FOUND' }));
    const r = await service.run('lead1', DOMAIN, CANDIDATES, caps);
    expect(r.outcome).toBe('NOT_FOUND');
    expect(r.accepted).toBeNull();
  });
  it('fails closed when verified but the returned identity does not match', async () => {
    const { service } = svc((q) => outcome(q, {
      email: `x@${q.domain}`, verificationStatus: 'VERIFIED',
      returnedIdentity: { name: 'Wrong Person', firstName: 'Wrong', lastName: 'Person', domain: q.domain, title: q.title },
    }));
    const r = await service.run('lead1', DOMAIN, CANDIDATES, caps);
    expect(r.outcome).toBe('NOT_FOUND');
    expect(r.accepted).toBeNull();
  });
  it('never accepts a generic verified address (no info@ fallback)', async () => {
    const { service } = svc((q) => outcome(q, { email: `info@${q.domain}`, verificationStatus: 'VERIFIED', returnedIdentity: null }));
    const r = await service.run('lead1', DOMAIN, CANDIDATES, caps);
    expect(r.outcome).toBe('NOT_FOUND');
  });
  it('enforces the request cap (CAPPED)', async () => {
    const { service, enrichSpy } = svc((q) => outcome(q, { verificationStatus: 'NOT_FOUND' }));
    const r = await service.run('lead1', DOMAIN, CANDIDATES, { maxRequests: 1, maxCredits: 9, minCreditsPerLookup: 1 });
    expect(r.outcome).toBe('CAPPED');
    expect(enrichSpy).toHaveBeenCalledTimes(1);
  });
  it('enforces the credit cap before spending', async () => {
    const { service, enrichSpy } = svc(verifiedResponder('Shastri'));
    const r = await service.run('lead1', DOMAIN, CANDIDATES, { maxRequests: 9, maxCredits: 1, minCreditsPerLookup: 2 });
    expect(r.outcome).toBe('CAPPED');
    expect(enrichSpy).toHaveBeenCalledTimes(0);
  });
  it('is idempotent: a persisted result is returned without re-spending', async () => {
    const store = new MemStore();
    const { service, enrichSpy } = svc(verifiedResponder('Shastri'), store);
    const r1 = await service.run('lead1', DOMAIN, CANDIDATES, caps);
    const r2 = await service.run('lead1', DOMAIN, CANDIDATES, caps);
    expect(r2.id).toBe(r1.id);
    expect(enrichSpy).toHaveBeenCalledTimes(1);
    expect(store.rows).toHaveLength(1);
  });
  it('never retries a provider error (fail closed as ERROR)', async () => {
    const provider = new MockContactEnrichmentProvider();
    vi.spyOn(provider, 'enrich').mockRejectedValue(new Error('boom'));
    const service = new ContactEnrichmentService({ provider, store: new MemStore(), logger });
    const r = await service.run('lead1', DOMAIN, CANDIDATES, caps);
    expect(r.outcome).toBe('ERROR');
  });
  it('computeInputHash is stable regardless of candidate array order', () => {
    expect(computeInputHash('instantly', DOMAIN, CANDIDATES)).toBe(computeInputHash('instantly', 'DIAMOND-SMILE.com', [...CANDIDATES].reverse()));
  });
});

describe('Instantly provider — real 3-step sequence (fake transport, zero network/credits)', () => {
  function fakeFetch(seq: Array<{ ok?: boolean; status?: number; body: unknown }>): { fetchImpl: FetchLike; calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> } {
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
    let i = 0;
    const fetchImpl = ((url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: init.body as string | undefined });
      const r = seq[Math.min(i, seq.length - 1)]; i += 1;
      return Promise.resolve({ ok: r.ok ?? true, status: r.status ?? 200, text: () => Promise.resolve(JSON.stringify(r.body)) } as unknown as Response);
    }) as unknown as FetchLike;
    return { fetchImpl, calls };
  }
  function provider(fetchImpl: FetchLike) {
    return new InstantlyContactEnrichmentProvider({
      apiKey: 'secret-key-123', baseUrl: 'https://api.instantly.ai/api/v2', timeoutMs: 5000,
      pollMaxAttempts: 4, pollIntervalMs: 1, logger, fetchImpl, sleep: () => Promise.resolve(),
    });
  }
  const q: EnrichmentQuery = { domain: DOMAIN, fullName: 'Shyam Shastri', firstName: 'Shyam', lastName: 'Shastri', title: 'Principal Dentist' };

  it('enrich -> poll -> leads/list; returns verified email + identity; Bearer auth; no key leak', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { body: { resource_id: 'list_9' } },
      { body: { resource_id: 'list_9', in_progress: false, credits_used: 1 } },
      { body: { items: [{ work_email: `shyam@${DOMAIN}`, first_name: 'Shyam', last_name: 'Shastri', company_domain: DOMAIN, title: 'Principal Dentist', email_verification: { status: 'valid', score: 0.99 }, data_quality: 'high' }] } },
    ]);
    const r = await provider(fetchImpl).enrich(q);
    expect(r.email).toBe(`shyam@${DOMAIN}`);
    expect(r.verificationStatus).toBe('VERIFIED');
    expect(r.creditsUsed).toBe(1);
    expect(r.resourceId).toBe('list_9');
    expect(r.returnedIdentity).toMatchObject({ firstName: 'Shyam', lastName: 'Shastri', domain: DOMAIN, title: 'Principal Dentist' });
    // 3-step endpoint sequence
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/supersearch-enrichment/enrich-leads-from-supersearch');
    expect(calls[1].method).toBe('GET');
    expect(calls[1].url).toContain('/supersearch-enrichment/list_9');
    expect(calls[2].method).toBe('POST');
    expect(calls[2].url).toContain('/leads/list');
    // request shapes
    expect(JSON.parse(calls[0].body ?? '{}')).toMatchObject({ limit: 1, work_email_enrichment: true, skip_rows_without_email: true, search_filters: { name: ['Shyam Shastri'], domains: [DOMAIN], title: { include: ['Principal Dentist'] } } });
    expect(JSON.parse(calls[2].body ?? '{}')).toMatchObject({ list_id: 'list_9' });
    for (const call of calls) expect(call.headers.Authorization).toBe('Bearer secret-key-123');
    expect(calls[0].body).not.toContain('secret-key-123');
  });

  it('polls until in_progress clears, then lists (bounded)', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { body: { resource_id: 'list_2' } },
      { body: { resource_id: 'list_2', in_progress: true } },
      { body: { resource_id: 'list_2', in_progress: false } },
      { body: { leads: [{ email: `a@${DOMAIN}`, first_name: 'Shyam', last_name: 'Shastri', domain: DOMAIN, title: 'Principal Dentist', verification_status: 'valid' }] } },
    ]);
    const r = await provider(fetchImpl).enrich(q);
    expect(r.verificationStatus).toBe('VERIFIED');
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2);
    expect(calls.filter((c) => c.url.includes('/leads/list'))).toHaveLength(1);
  });

  it('returns NOT_FOUND (no email) when the list is empty', async () => {
    const { fetchImpl } = fakeFetch([
      { body: { resource_id: 'list_e' } },
      { body: { in_progress: false } },
      { body: { items: [] } },
    ]);
    const r = await provider(fetchImpl).enrich(q);
    expect(r.email).toBeNull();
    expect(r.verificationStatus).toBe('NOT_FOUND');
    expect(r.returnedIdentity).toBeNull();
  });

  it('STOPS (schema mismatch) when a lead is returned without a recognizable email field', async () => {
    const { fetchImpl } = fakeFetch([
      { body: { resource_id: 'list_x' } },
      { body: { in_progress: false } },
      { body: { items: [{ first_name: 'Shyam', last_name: 'Shastri', some_other_field: 'x' }] } },
    ]);
    await expect(provider(fetchImpl).enrich(q)).rejects.toMatchObject({ code: 'INSTANTLY_SCHEMA_MISMATCH' });
  });

  it('STOPS (schema mismatch) when a lead has an email but no verification field', async () => {
    const { fetchImpl } = fakeFetch([
      { body: { resource_id: 'list_v' } },
      { body: { in_progress: false } },
      { body: { items: [{ work_email: `shyam@${DOMAIN}`, first_name: 'Shyam', last_name: 'Shastri' }] } },
    ]);
    await expect(provider(fetchImpl).enrich(q)).rejects.toMatchObject({ code: 'INSTANTLY_SCHEMA_MISMATCH' });
  });

  it('throws on non-2xx without leaking the API key', async () => {
    const { fetchImpl } = fakeFetch([{ ok: false, status: 401, body: { error: 'unauthorized' } }]);
    await expect(provider(fetchImpl).enrich(q)).rejects.toMatchObject({ code: 'INSTANTLY_HTTP_401' });
    await expect(provider(fetchImpl).enrich(q)).rejects.toThrow(/^(?!.*secret-key-123).*$/);
  });

  it('maps verification vocabulary', () => {
    const cases: Array<[string | null, EnrichmentVerificationStatus]> = [
      ['valid', 'VERIFIED'], ['verified', 'VERIFIED'], ['catch_all', 'CATCH_ALL'], ['risky', 'RISKY'], ['invalid', 'INVALID'], ['weird', 'UNKNOWN'], ['', 'NOT_FOUND'], [null, 'NOT_FOUND'],
    ];
    for (const [raw, expected] of cases) expect(normalizeInstantlyVerification(raw)).toBe(expected);
  });

  it('builds the documented request bodies', () => {
    const body = buildEnrichLeadsRequestBody(q) as { limit: number; work_email_enrichment: boolean; skip_rows_without_email: boolean; search_filters: Record<string, unknown> };
    expect(body).toMatchObject({ limit: 1, work_email_enrichment: true, skip_rows_without_email: true });
    expect(body.search_filters).toEqual({ name: ['Shyam Shastri'], domains: [DOMAIN], title: { include: ['Principal Dentist'] } });
    expect(buildLeadsListRequestBody('list_9')).toEqual({ list_id: 'list_9', limit: 1 });
  });
});

describe('buildContactEnrichmentProvider gating', () => {
  const base = {
    CONTACT_ENRICHMENT_PROVIDER: 'instantly', CONTACT_ENRICHMENT_ENABLED: false, ALLOW_PAID_ENRICHMENT_CALLS: false,
    INSTANTLY_API_KEY: undefined as string | undefined, INSTANTLY_API_BASE_URL: 'https://api.instantly.ai/api/v2',
    INSTANTLY_TIMEOUT_MS: 30000, INSTANTLY_POLL_MAX_ATTEMPTS: 8, INSTANTLY_POLL_INTERVAL_MS: 2000,
  };
  const ctx = (over: Partial<typeof base>) => ({ config: { ...base, ...over }, logger } as unknown as Parameters<typeof buildContactEnrichmentProvider>[0]);
  it('returns the mock provider when provider != instantly', () => { expect(buildContactEnrichmentProvider(ctx({ CONTACT_ENRICHMENT_PROVIDER: 'mock' })).name).toBe('mock'); });
  it('fails closed without enable flag', () => { expect(() => buildContactEnrichmentProvider(ctx({}))).toThrow(/CONTACT_ENRICHMENT_ENABLED/); });
  it('fails closed without the paid kill switch', () => { expect(() => buildContactEnrichmentProvider(ctx({ CONTACT_ENRICHMENT_ENABLED: true }))).toThrow(/ALLOW_PAID_ENRICHMENT_CALLS/); });
  it('fails closed without an API key', () => { expect(() => buildContactEnrichmentProvider(ctx({ CONTACT_ENRICHMENT_ENABLED: true, ALLOW_PAID_ENRICHMENT_CALLS: true }))).toThrow(/INSTANTLY_API_KEY/); });
  it('constructs when fully gated open', () => { expect(buildContactEnrichmentProvider(ctx({ CONTACT_ENRICHMENT_ENABLED: true, ALLOW_PAID_ENRICHMENT_CALLS: true, INSTANTLY_API_KEY: 'k' })).name).toBe('instantly'); });
});
