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
  type EnrichmentMode,
  type EnrichmentQuery,
  type EnrichmentVerificationStatus,
  type PreviewPerson,
  type ProviderEnrichmentOutcome,
} from '../../src/domain/contact-enrichment/types.js';
import { decideAcceptance, isGenericMailbox, matchPreviewPerson } from '../../src/domain/contact-enrichment/verification.js';
import { MockContactEnrichmentProvider, type MockEnrichmentResponder, type MockPreviewResponder } from '../../src/integrations/contact-enrichment/mock-provider.js';
import { InstantlyContactEnrichmentProvider, type FetchLike } from '../../src/integrations/contact-enrichment/instantly-provider.js';
import { buildEnrichLeadsRequestBody, buildPreviewLeadsFromSupersearchRequestBody, normalizeInstantlyVerification } from '../../src/integrations/contact-enrichment/instantly-schema.js';
import { buildContactEnrichmentProvider } from '../../src/cli/commands/contact-enrich-build.js';
import { validateDomainSearchOnlyFlags, type ContactEnrichCliOptions } from '../../src/cli/commands/contact-enrich.js';

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;
const caps: EnrichmentRunCaps = { maxRequests: 3, maxCredits: 3, minCreditsPerLookup: 1 };
const DOMAIN = 'diamond-smile.com';
const FULL = { performEnrichment: true };
const PREVIEW_ONLY = { performEnrichment: false };

function person(name: string, title: string, priority: number): CandidatePerson {
  const t = name.split(/\s+/);
  return { fullName: name, firstName: t[0] ?? name, lastName: t[t.length - 1] ?? name, title, priority };
}
const CANDIDATES: CandidatePerson[] = [
  person('Shyam Shastri', 'Principal Dentist', 1),
  person('Shaimil Patel', 'Clinical Director', 2),
  person('Kymya Doyley', 'Practice Manager', 3),
];

function previewPersonFor(p: CandidatePerson, domain: string): PreviewPerson {
  return { name: p.fullName, firstName: p.firstName, lastName: p.lastName, domain, title: p.title, providerLeadId: `L-${p.lastName}` };
}
function previewResponder(...people: PreviewPerson[]): MockPreviewResponder {
  return (domain) => ({ domain, people, creditsReported: null, resourceId: 'prev', endpoint: 'mock://preview', rawDigest: 'pd' });
}
function outcome(query: EnrichmentQuery, over: Partial<ProviderEnrichmentOutcome>): ProviderEnrichmentOutcome {
  return {
    query, email: null, returnedIdentity: null, verificationStatus: 'NOT_FOUND', dataQuality: null, confidence: null,
    creditsReported: null, resourceId: null, endpoint: 'mock://x', rawDigest: 'd', ...over,
  };
}
function enrichVerified(forLast: string): MockEnrichmentResponder {
  return (q) => q.lastName !== forLast ? outcome(q, {}) : outcome(q, {
    email: `${q.firstName.toLowerCase()}@${q.domain}`, verificationStatus: 'VERIFIED', dataQuality: 'high', confidence: 0.98, creditsReported: 1,
    returnedIdentity: { name: q.fullName, firstName: q.firstName, lastName: q.lastName, domain: q.domain, title: q.title },
  });
}

class MemStore implements ContactEnrichmentStore {
  rows: ContactEnrichmentResult[] = [];
  findByInputHash(leadId: string, provider: string, mode: EnrichmentMode, inputHash: string): Promise<ContactEnrichmentResult | null> {
    return Promise.resolve(this.rows.find((r) => r.leadId === leadId && r.provider === provider && r.mode === mode && r.inputHash === inputHash) ?? null);
  }
  save(result: ContactEnrichmentResult): Promise<void> { this.rows.push(result); return Promise.resolve(); }
}
function svc(preview: MockPreviewResponder, enrich: MockEnrichmentResponder = () => outcome({ domain: DOMAIN, fullName: '', firstName: '', lastName: '', title: '' }, {}), store = new MemStore()) {
  const provider = new MockContactEnrichmentProvider(enrich, preview);
  const previewSpy = vi.spyOn(provider, 'preview');
  const enrichSpy = vi.spyOn(provider, 'enrich');
  return { service: new ContactEnrichmentService({ provider, store, logger }), store, previewSpy, enrichSpy };
}

describe('verification: preview match + acceptance', () => {
  const p = CANDIDATES[0];
  it('matchPreviewPerson: name+domain+non-conflicting title', () => {
    expect(matchPreviewPerson(previewPersonFor(p, DOMAIN), p, DOMAIN).isMatch).toBe(true);
    expect(matchPreviewPerson({ ...previewPersonFor(p, DOMAIN), title: 'Receptionist' }, p, DOMAIN).isMatch).toBe(false);
    expect(matchPreviewPerson({ ...previewPersonFor(p, DOMAIN), lastName: 'Other', name: 'Shyam Other' }, p, DOMAIN).isMatch).toBe(false);
    expect(matchPreviewPerson({ ...previewPersonFor(p, DOMAIN), title: null }, p, DOMAIN).isMatch).toBe(true); // unconfirmed title ok
  });
  it('decideAcceptance still enforces verified + host + identity', () => {
    const q: EnrichmentQuery = { domain: DOMAIN, fullName: p.fullName, firstName: p.firstName, lastName: p.lastName, title: p.title };
    const good = outcome(q, { email: `shyam@${DOMAIN}`, verificationStatus: 'VERIFIED', returnedIdentity: { name: p.fullName, firstName: p.firstName, lastName: p.lastName, domain: DOMAIN, title: p.title } });
    expect(decideAcceptance(good, p, DOMAIN).accepted).toBe(true);
    expect(decideAcceptance(outcome(q, { ...good, email: `info@${DOMAIN}` }), p, DOMAIN).reason).toBe('generic_mailbox_rejected');
    expect(isGenericMailbox(`info@${DOMAIN}`)).toBe(true);
  });
});

describe('service: preview-first strategy', () => {
  it('preview coverage=0 → PREVIEW_NO_MATCH, NO enrichment call', async () => {
    const { service, enrichSpy } = svc(previewResponder());
    const r = await service.run('l', DOMAIN, CANDIDATES, caps, FULL);
    expect(r.outcome).toBe('PREVIEW_NO_MATCH');
    expect(enrichSpy).not.toHaveBeenCalled();
    expect(r.creditsEstimated).toBe(0);
  });
  it('preview has people but none match → PREVIEW_NO_MATCH, NO enrichment', async () => {
    const stranger: PreviewPerson = { name: 'Someone Else', firstName: 'Someone', lastName: 'Else', domain: DOMAIN, title: 'Dentist', providerLeadId: 'x' };
    const { service, enrichSpy } = svc(previewResponder(stranger));
    const r = await service.run('l', DOMAIN, CANDIDATES, caps, FULL);
    expect(r.outcome).toBe('PREVIEW_NO_MATCH');
    expect(enrichSpy).not.toHaveBeenCalled();
  });
  it('preview matches + performEnrichment=false → PREVIEW_MATCHED, NO enrichment', async () => {
    const { service, enrichSpy } = svc(previewResponder(previewPersonFor(CANDIDATES[0], DOMAIN)));
    const r = await service.run('l', DOMAIN, CANDIDATES, caps, PREVIEW_ONLY);
    expect(r.outcome).toBe('PREVIEW_MATCHED');
    expect(enrichSpy).not.toHaveBeenCalled();
    expect((r.provenance as { matches: unknown[] }).matches).toHaveLength(1);
    expect(r.mode).toBe('PREVIEW');
    expect(r.creditsEstimated).toBe(0); // preview never estimates a spend
    expect(r.creditsReported).toBeNull(); // no real preview charge reported by the provider
  });
  it('preview match → paid enrich → VERIFIED (only the matched person is enriched)', async () => {
    const { service, previewSpy, enrichSpy } = svc(previewResponder(previewPersonFor(CANDIDATES[0], DOMAIN)), enrichVerified('Shastri'));
    const r = await service.run('l', DOMAIN, CANDIDATES, caps, FULL);
    expect(r.outcome).toBe('VERIFIED');
    expect(r.accepted?.email).toBe(`shyam@${DOMAIN}`);
    expect(previewSpy).toHaveBeenCalledTimes(1);
    expect(enrichSpy).toHaveBeenCalledTimes(1);
    expect(r.creditsEstimated).toBe(1);
    expect(r.creditsReported).toBe(1);
  });
  it('enriches matched people in priority order (preferred preview-miss, fallback matches)', async () => {
    const { service, enrichSpy } = svc(previewResponder(previewPersonFor(CANDIDATES[1], DOMAIN)), enrichVerified('Patel'));
    const r = await service.run('l', DOMAIN, CANDIDATES, caps, FULL);
    expect(r.accepted?.title).toBe('Clinical Director');
    expect(enrichSpy).toHaveBeenCalledTimes(1); // only the matched person
  });
  it('matched but enrichment returns a generic verified address → NOT_FOUND (no info@ fallback)', async () => {
    const enrich: MockEnrichmentResponder = (q) => outcome(q, { email: `info@${q.domain}`, verificationStatus: 'VERIFIED', returnedIdentity: { name: q.fullName, firstName: q.firstName, lastName: q.lastName, domain: q.domain, title: q.title } });
    const { service } = svc(previewResponder(previewPersonFor(CANDIDATES[0], DOMAIN)), enrich);
    const r = await service.run('l', DOMAIN, CANDIDATES, caps, FULL);
    expect(r.outcome).toBe('NOT_FOUND');
    expect(r.accepted).toBeNull();
  });
  it('credit accounting: reported stays null when the provider reports nothing', async () => {
    const enrich: MockEnrichmentResponder = (q) => outcome(q, { email: `shyam@${q.domain}`, verificationStatus: 'RISKY', creditsReported: null, returnedIdentity: { name: q.fullName, firstName: q.firstName, lastName: q.lastName, domain: q.domain, title: q.title } });
    const { service } = svc(previewResponder(previewPersonFor(CANDIDATES[0], DOMAIN)), enrich);
    const r = await service.run('l', DOMAIN, CANDIDATES, caps, FULL);
    expect(r.creditsEstimated).toBe(1); // one attempt
    expect(r.creditsReported).toBeNull(); // provider reported nothing → not a fabricated 1
  });
  it('ENRICH → same ENRICH is idempotent (no re-preview, no re-spend)', async () => {
    const store = new MemStore();
    const { service, previewSpy, enrichSpy } = svc(previewResponder(previewPersonFor(CANDIDATES[0], DOMAIN)), enrichVerified('Shastri'), store);
    const r1 = await service.run('l', DOMAIN, CANDIDATES, caps, FULL);
    const r2 = await service.run('l', DOMAIN, CANDIDATES, caps, FULL);
    expect(r2.id).toBe(r1.id);
    expect(r1.mode).toBe('ENRICH');
    expect(previewSpy).toHaveBeenCalledTimes(1);
    expect(enrichSpy).toHaveBeenCalledTimes(1);
  });
  it('PREVIEW → same PREVIEW is idempotent (zero additional network calls)', async () => {
    const store = new MemStore();
    const { service, previewSpy, enrichSpy } = svc(previewResponder(previewPersonFor(CANDIDATES[0], DOMAIN)), enrichVerified('Shastri'), store);
    const r1 = await service.run('l', DOMAIN, CANDIDATES, caps, PREVIEW_ONLY);
    const r2 = await service.run('l', DOMAIN, CANDIDATES, caps, PREVIEW_ONLY);
    expect(r2.id).toBe(r1.id);
    expect(r1.mode).toBe('PREVIEW');
    expect(previewSpy).toHaveBeenCalledTimes(1);
    expect(enrichSpy).not.toHaveBeenCalled();
  });
  it('ENRICH then PREVIEW are distinct operations: a stale ENRICH result never suppresses a later PREVIEW', async () => {
    const store = new MemStore();
    // First: a real ENRICH run that results in NOT_FOUND (no candidate accepted).
    const { service, previewSpy, enrichSpy } = svc(previewResponder(previewPersonFor(CANDIDATES[0], DOMAIN)), () => outcome({ domain: DOMAIN, fullName: '', firstName: '', lastName: '', title: '' }, {}), store);
    const enrichResult = await service.run('l', DOMAIN, CANDIDATES, caps, FULL);
    expect(enrichResult.outcome).toBe('NOT_FOUND');
    expect(enrichResult.mode).toBe('ENRICH');
    expect(previewSpy).toHaveBeenCalledTimes(1);
    expect(enrichSpy).toHaveBeenCalledTimes(1);

    // Then: a PREVIEW for the identical lead/domain/candidates must run its OWN preview, not replay the ENRICH row.
    const previewResult = await service.run('l', DOMAIN, CANDIDATES, caps, PREVIEW_ONLY);
    expect(previewResult.id).not.toBe(enrichResult.id);
    expect(previewResult.mode).toBe('PREVIEW');
    expect(previewResult.outcome).toBe('PREVIEW_MATCHED');
    expect(previewSpy).toHaveBeenCalledTimes(2); // preview ran again — NOT suppressed by the cached ENRICH NOT_FOUND
    expect(enrichSpy).toHaveBeenCalledTimes(1); // still only the one paid call from the earlier ENRICH run
  });
  it('PREVIEW then ENRICH are distinct operations: a stale PREVIEW never suppresses a later paid ENRICH', async () => {
    const store = new MemStore();
    const { service, previewSpy, enrichSpy } = svc(previewResponder(previewPersonFor(CANDIDATES[0], DOMAIN)), enrichVerified('Shastri'), store);
    const previewResult = await service.run('l', DOMAIN, CANDIDATES, caps, PREVIEW_ONLY);
    expect(previewResult.outcome).toBe('PREVIEW_MATCHED');
    expect(previewResult.mode).toBe('PREVIEW');
    expect(previewSpy).toHaveBeenCalledTimes(1);
    expect(enrichSpy).not.toHaveBeenCalled();

    const enrichResult = await service.run('l', DOMAIN, CANDIDATES, caps, FULL);
    expect(enrichResult.id).not.toBe(previewResult.id);
    expect(enrichResult.mode).toBe('ENRICH');
    expect(enrichResult.outcome).toBe('VERIFIED');
    expect(previewSpy).toHaveBeenCalledTimes(2); // the ENRICH run performed its own preview, not reused from the cached PREVIEW row
    expect(enrichSpy).toHaveBeenCalledTimes(1); // the paid call actually happened — was NOT suppressed by the cached preview
  });
  it('never retries a preview error (ERROR, fail closed)', async () => {
    const provider = new MockContactEnrichmentProvider();
    vi.spyOn(provider, 'preview').mockRejectedValue(new Error('boom'));
    const r = await new ContactEnrichmentService({ provider, store: new MemStore(), logger }).run('l', DOMAIN, CANDIDATES, caps, FULL);
    expect(r.outcome).toBe('ERROR');
  });
  it('computeInputHash stable regardless of order', () => {
    expect(computeInputHash('ENRICH', 'instantly', DOMAIN, CANDIDATES)).toBe(computeInputHash('ENRICH', 'instantly', 'DIAMOND-SMILE.com', [...CANDIDATES].reverse()));
  });
  it('computeInputHash differs by mode for identical provider/domain/candidates', () => {
    expect(computeInputHash('PREVIEW', 'instantly', DOMAIN, CANDIDATES)).not.toBe(computeInputHash('ENRICH', 'instantly', DOMAIN, CANDIDATES));
  });
});

describe('Instantly provider — preview + enrich sequences (fake transport)', () => {
  function fakeFetch(seq: Array<{ ok?: boolean; status?: number; body: unknown }>) {
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
    let i = 0;
    const fetchImpl = ((url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: init.body as string | undefined });
      const r = seq[Math.min(i, seq.length - 1)]; i += 1;
      return Promise.resolve({ ok: r.ok ?? true, status: r.status ?? 200, text: () => Promise.resolve(JSON.stringify(r.body)) } as unknown as Response);
    }) as unknown as FetchLike;
    return { fetchImpl, calls };
  }
  function provider(fetchImpl: FetchLike, allowPaidEnrichment = true) {
    return new InstantlyContactEnrichmentProvider({
      apiKey: 'secret-key-123', baseUrl: 'https://api.instantly.ai/api/v2', timeoutMs: 5000,
      pollMaxAttempts: 4, pollIntervalMs: 1, previewLimit: 25, allowPaidEnrichment, logger, fetchImpl, sleep: () => Promise.resolve(),
    });
  }
  const q: EnrichmentQuery = { domain: DOMAIN, fullName: 'Shyam Shastri', firstName: 'Shyam', lastName: 'Shastri', title: 'Principal Dentist' };

  it('preview: calls exactly /preview-leads-from-supersearch, ONE request, never the enrich job endpoint', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { body: { number_of_leads: 1, number_of_redacted_results: 0, leads: [{ firstName: 'Shyam', lastName: 'Shastri', fullName: 'Shyam Shastri', jobTitle: 'Principal Dentist', companyName: 'Diamond Smile' }] } },
    ]);
    const r = await provider(fetchImpl).preview(DOMAIN);
    expect(calls).toHaveLength(1); // synchronous — no poll, no leads/list
    expect(calls[0].url).toContain('/supersearch-enrichment/preview-leads-from-supersearch');
    for (const call of calls) expect(call.url).not.toContain('/enrich-leads-from-supersearch');
    expect(r.people).toHaveLength(1);
    expect(r.people[0]).toMatchObject({ firstName: 'Shyam', lastName: 'Shastri', title: 'Principal Dentist' });
    for (const call of calls) expect(call.headers.Authorization).toBe('Bearer secret-key-123');
  });
  it('preview request is domain-first: no title filter, work_email_enrichment not enabled', async () => {
    const { fetchImpl, calls } = fakeFetch([{ body: { number_of_leads: 0, number_of_redacted_results: 0, leads: [] } }]);
    await provider(fetchImpl).preview(DOMAIN);
    const body = JSON.parse(calls[0].body ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({ search_filters: { domains: [DOMAIN] } });
    expect((body['search_filters'] as Record<string, unknown>)['title']).toBeUndefined();
    expect((body['search_filters'] as Record<string, unknown>)['name']).toBeUndefined();
    expect(body['work_email_enrichment']).not.toBe(true);
  });
  it('parses the official preview response shape (number_of_leads/number_of_redacted_results/leads[])', async () => {
    const { fetchImpl } = fakeFetch([{
      body: {
        number_of_leads: 2, number_of_redacted_results: 1,
        leads: [
          { firstName: 'Shyam', lastName: 'Shastri', fullName: 'Shyam Shastri', jobTitle: 'Principal Dentist', companyName: 'Diamond Smile' },
          { firstName: 'Someone', lastName: 'Else', fullName: 'Someone Else', jobTitle: 'Receptionist', companyName: 'Diamond Smile' },
        ],
      },
    }]);
    const r = await provider(fetchImpl).preview(DOMAIN);
    expect(r.people).toHaveLength(2);
    expect(r.people[0]).toMatchObject({ firstName: 'Shyam', lastName: 'Shastri', name: 'Shyam Shastri', title: 'Principal Dentist' });
    expect(r.creditsReported).toBeNull(); // this response shape carries no credits field
  });
  it('zero-result preview → empty people (service layer turns this into PREVIEW_NO_MATCH)', async () => {
    const { fetchImpl } = fakeFetch([{ body: { number_of_leads: 0, number_of_redacted_results: 0, leads: [] } }]);
    const r = await provider(fetchImpl).preview(DOMAIN);
    expect(r.people).toHaveLength(0);
  });
  it('domain preview results are locally matched to the requested candidates by name/title', async () => {
    const { fetchImpl } = fakeFetch([{
      body: {
        number_of_leads: 3, number_of_redacted_results: 0,
        leads: [
          { firstName: 'Shyam', lastName: 'Shastri', fullName: 'Shyam Shastri', jobTitle: 'Principal Dentist', companyName: 'Diamond Smile' },
          { firstName: 'Shaimil', lastName: 'Patel', fullName: 'Shaimil Patel', jobTitle: 'Clinical Director', companyName: 'Diamond Smile' },
          { firstName: 'Someone', lastName: 'Else', fullName: 'Someone Else', jobTitle: 'Front Desk', companyName: 'Diamond Smile' },
        ],
      },
    }]);
    const r = await provider(fetchImpl).preview(DOMAIN);
    const matchFor = (candidateName: string) => {
      const candidate = CANDIDATES.find((c) => c.fullName === candidateName)!;
      return r.people.find((p) => matchPreviewPerson(p, candidate, DOMAIN).isMatch);
    };
    expect(matchFor('Shyam Shastri')).toBeTruthy();
    expect(matchFor('Shaimil Patel')).toBeTruthy();
    expect(matchFor('Kymya Doyley')).toBeUndefined(); // not present in this preview response
  });
  it('service: real Instantly provider — same PREVIEW is idempotent (zero additional network calls)', async () => {
    const { fetchImpl, calls } = fakeFetch([{
      body: { number_of_leads: 1, number_of_redacted_results: 0, leads: [{ firstName: 'Shyam', lastName: 'Shastri', fullName: 'Shyam Shastri', jobTitle: 'Principal Dentist', companyName: 'Diamond Smile' }] },
    }]);
    const store = new MemStore();
    const service = new ContactEnrichmentService({ provider: provider(fetchImpl), store, logger });
    const r1 = await service.run('l', DOMAIN, CANDIDATES, caps, PREVIEW_ONLY);
    const r2 = await service.run('l', DOMAIN, CANDIDATES, caps, PREVIEW_ONLY);
    expect(r2.id).toBe(r1.id);
    expect(calls).toHaveLength(1); // second run was an idempotent hit — no additional HTTP call
  });
  it('enrich: 3-step, verified email + identity; fails closed if paid disabled', async () => {
    const seq = [
      { body: { resource_id: 'list_9' } },
      { body: { in_progress: false, credits_used: 1 } },
      { body: { items: [{ work_email: `shyam@${DOMAIN}`, first_name: 'Shyam', last_name: 'Shastri', company_domain: DOMAIN, title: 'Principal Dentist', email_verification: { status: 'valid' } }] } },
    ];
    const r = await provider(fakeFetch(seq).fetchImpl).enrich(q);
    expect(r.email).toBe(`shyam@${DOMAIN}`);
    expect(r.verificationStatus).toBe('VERIFIED');
    expect(r.creditsReported).toBe(1);
    await expect(provider(fakeFetch(seq).fetchImpl, false).enrich(q)).rejects.toMatchObject({ code: 'ENRICHMENT_PROVIDER_NOT_ALLOWED' });
  });
  it('enrich: empty list → NOT_FOUND; missing email field → schema mismatch (stops)', async () => {
    const empty = await provider(fakeFetch([{ body: { resource_id: 'e' } }, { body: { in_progress: false } }, { body: { items: [] } }]).fetchImpl).enrich(q);
    expect(empty.verificationStatus).toBe('NOT_FOUND');
    await expect(provider(fakeFetch([{ body: { resource_id: 'x' } }, { body: { in_progress: false } }, { body: { items: [{ first_name: 'Shyam', last_name: 'Shastri' }] } }]).fetchImpl).enrich(q))
      .rejects.toMatchObject({ code: 'INSTANTLY_SCHEMA_MISMATCH' });
  });
  it('does not report a fabricated credit when the provider omits it', async () => {
    const r = await provider(fakeFetch([{ body: { resource_id: 'r' } }, { body: { in_progress: false } }, { body: { items: [{ work_email: `a@${DOMAIN}`, first_name: 'Shyam', last_name: 'Shastri', domain: DOMAIN, email_verification: { status: 'valid' } }] } }]).fetchImpl).enrich(q);
    expect(r.creditsReported).toBeNull();
  });
  it('maps verification vocabulary + builds request bodies', () => {
    const cases: Array<[string | null, EnrichmentVerificationStatus]> = [['valid', 'VERIFIED'], ['catch_all', 'CATCH_ALL'], ['risky', 'RISKY'], ['invalid', 'INVALID'], ['', 'NOT_FOUND']];
    for (const [raw, exp] of cases) expect(normalizeInstantlyVerification(raw)).toBe(exp);
    expect(buildPreviewLeadsFromSupersearchRequestBody(DOMAIN, 25)).toEqual({ limit: 25, search_filters: { domains: [DOMAIN] } });
    expect((buildEnrichLeadsRequestBody(q) as { search_filters: { name: string[] } }).search_filters.name).toEqual(['Shyam Shastri']);
  });
});

describe('buildContactEnrichmentProvider gating + DRY_RUN kill switch', () => {
  const base = {
    DRY_RUN: false, CONTACT_ENRICHMENT_PROVIDER: 'instantly', CONTACT_ENRICHMENT_ENABLED: true, ALLOW_PAID_ENRICHMENT_CALLS: true,
    INSTANTLY_API_KEY: 'k', INSTANTLY_API_BASE_URL: 'https://api.instantly.ai/api/v2', INSTANTLY_TIMEOUT_MS: 30000,
    INSTANTLY_POLL_MAX_ATTEMPTS: 8, INSTANTLY_POLL_INTERVAL_MS: 2000, CONTACT_ENRICHMENT_PREVIEW_LIMIT: 25,
  };
  const ctx = (over: Partial<typeof base>) => ({ config: { ...base, ...over }, logger } as unknown as Parameters<typeof buildContactEnrichmentProvider>[0]);

  it('mock provider when provider != instantly (unaffected by DRY_RUN)', () => {
    expect(buildContactEnrichmentProvider(ctx({ CONTACT_ENRICHMENT_PROVIDER: 'mock', DRY_RUN: true })).name).toBe('mock');
  });
  it('DRY_RUN=true blocks live Instantly even with all paid flags + key (fail closed before network)', () => {
    expect(() => buildContactEnrichmentProvider(ctx({ DRY_RUN: true }))).toThrow(/DRY_RUN=true blocks/);
  });
  it('constructs live provider when DRY_RUN=false + enabled + key (preview allowed without paid flag)', () => {
    expect(buildContactEnrichmentProvider(ctx({ ALLOW_PAID_ENRICHMENT_CALLS: false })).name).toBe('instantly');
  });
  it('fails closed without enable flag / without key', () => {
    expect(() => buildContactEnrichmentProvider(ctx({ CONTACT_ENRICHMENT_ENABLED: false }))).toThrow(/CONTACT_ENRICHMENT_ENABLED/);
    expect(() => buildContactEnrichmentProvider(ctx({ INSTANTLY_API_KEY: undefined }))).toThrow(/INSTANTLY_API_KEY/);
  });
});

describe('buildContactEnrichmentProvider — Hunter (fallback provider #2) gating + DRY_RUN kill switch', () => {
  const base = {
    DRY_RUN: false, CONTACT_ENRICHMENT_PROVIDER: 'hunter', CONTACT_ENRICHMENT_ENABLED: true, ALLOW_PAID_ENRICHMENT_CALLS: true,
    HUNTER_API_KEY: 'k', HUNTER_API_BASE_URL: 'https://api.hunter.io/v2', HUNTER_TIMEOUT_MS: 30000,
  };
  const ctx = (over: Partial<typeof base>) => ({ config: { ...base, ...over }, logger } as unknown as Parameters<typeof buildContactEnrichmentProvider>[0]);

  it('DRY_RUN=true blocks live Hunter even with all paid flags + key (fail closed before network)', () => {
    expect(() => buildContactEnrichmentProvider(ctx({ DRY_RUN: true }))).toThrow(/DRY_RUN=true blocks/);
  });
  it('constructs live Hunter provider when DRY_RUN=false + enabled + key (preview needs no paid flag — it is a zero-network echo)', () => {
    expect(buildContactEnrichmentProvider(ctx({ ALLOW_PAID_ENRICHMENT_CALLS: false })).name).toBe('hunter');
  });
  it('fails closed without enable flag / without key', () => {
    expect(() => buildContactEnrichmentProvider(ctx({ CONTACT_ENRICHMENT_ENABLED: false }))).toThrow(/CONTACT_ENRICHMENT_ENABLED/);
    expect(() => buildContactEnrichmentProvider(ctx({ HUNTER_API_KEY: undefined }))).toThrow(/HUNTER_API_KEY/);
  });
});

describe('buildContactEnrichmentProvider — Apollo (fallback provider #3) gating + DRY_RUN kill switch', () => {
  const base = {
    DRY_RUN: false, CONTACT_ENRICHMENT_PROVIDER: 'apollo', CONTACT_ENRICHMENT_ENABLED: true, ALLOW_PAID_ENRICHMENT_CALLS: true,
    APOLLO_API_KEY: 'k', APOLLO_API_BASE_URL: 'https://api.apollo.io/api/v1', APOLLO_TIMEOUT_MS: 30000,
    CONTACT_ENRICHMENT_PREVIEW_LIMIT: 25,
  };
  const ctx = (over: Partial<typeof base>) => ({ config: { ...base, ...over }, logger } as unknown as Parameters<typeof buildContactEnrichmentProvider>[0]);

  it('DRY_RUN=true blocks live Apollo even with all paid flags + key (fail closed before network)', () => {
    expect(() => buildContactEnrichmentProvider(ctx({ DRY_RUN: true }))).toThrow(/DRY_RUN=true blocks/);
  });
  it('constructs live Apollo provider when DRY_RUN=false + enabled + key (preview needs no paid flag — it is free)', () => {
    expect(buildContactEnrichmentProvider(ctx({ ALLOW_PAID_ENRICHMENT_CALLS: false })).name).toBe('apollo');
  });
  it('fails closed without enable flag / without key', () => {
    expect(() => buildContactEnrichmentProvider(ctx({ CONTACT_ENRICHMENT_ENABLED: false }))).toThrow(/CONTACT_ENRICHMENT_ENABLED/);
    expect(() => buildContactEnrichmentProvider(ctx({ APOLLO_API_KEY: undefined }))).toThrow(/APOLLO_API_KEY/);
  });
});

describe('validateDomainSearchOnlyFlags — CLI guard for --domain-search-only', () => {
  it('is a no-op when the flag is not set, regardless of provider/confirm', () => {
    expect(() => validateDomainSearchOnlyFlags({} as ContactEnrichCliOptions, 'instantly')).not.toThrow();
    expect(() => validateDomainSearchOnlyFlags({ confirm: false } as ContactEnrichCliOptions, 'mock')).not.toThrow();
  });
  it('rejects a non-Hunter provider', () => {
    expect(() => validateDomainSearchOnlyFlags({ domainSearchOnly: true, confirm: true } as ContactEnrichCliOptions, 'instantly'))
      .toThrow(/CONTACT_ENRICHMENT_PROVIDER=hunter/);
    expect(() => validateDomainSearchOnlyFlags({ domainSearchOnly: true, confirm: true } as ContactEnrichCliOptions, 'mock'))
      .toThrow(/CONTACT_ENRICHMENT_PROVIDER=hunter/);
  });
  it('rejects Hunter without --confirm', () => {
    expect(() => validateDomainSearchOnlyFlags({ domainSearchOnly: true } as ContactEnrichCliOptions, 'hunter'))
      .toThrow(/requires --confirm/);
  });
  it('passes for hunter + confirm', () => {
    expect(() => validateDomainSearchOnlyFlags({ domainSearchOnly: true, confirm: true } as ContactEnrichCliOptions, 'hunter')).not.toThrow();
  });
});
