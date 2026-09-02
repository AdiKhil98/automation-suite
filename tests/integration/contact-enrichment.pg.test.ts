import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { type Logger } from 'pino';
import { requireIntegrationTestDatabase } from '../support/test-database.js';
import { type DbHandle } from '../../src/persistence/db.js';
import { leads } from '../../src/persistence/schema.js';
import { ContactEnrichmentRepository } from '../../src/persistence/repositories/contact-enrichment.repo.js';
import { ContactEnrichmentService, computeInputHash, type EnrichmentRunCaps } from '../../src/domain/contact-enrichment/service.js';
import { MockContactEnrichmentProvider } from '../../src/integrations/contact-enrichment/mock-provider.js';
import { type CandidatePerson, type ContactEnrichmentResult, type DomainSearchResult, type EnrichmentQuery, type PreviewPerson, type PreviewResult, type ProviderEnrichmentOutcome } from '../../src/domain/contact-enrichment/types.js';
import { type ContactEnrichmentProvider } from '../../src/domain/contact-enrichment/provider.js';

const testDatabase = requireIntegrationTestDatabase();
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;
const caps: EnrichmentRunCaps = { maxRequests: 3, maxCredits: 3, minCreditsPerLookup: 1 };
const DOMAIN = 'diamond-smile.com';

const CANDIDATES: CandidatePerson[] = [
  { fullName: 'Shyam Shastri', firstName: 'Shyam', lastName: 'Shastri', title: 'Principal Dentist', priority: 1 },
  { fullName: 'Shaimil Patel', firstName: 'Shaimil', lastName: 'Patel', title: 'Clinical Director', priority: 2 },
];

function baseResult(leadId: string, over: Partial<ContactEnrichmentResult>): ContactEnrichmentResult {
  return {
    id: randomUUID(), leadId, provider: 'mock', mode: 'ENRICH', inputHash: randomUUID(), requestedDomain: DOMAIN,
    candidates: CANDIDATES, outcome: 'NOT_FOUND', accepted: null, creditsEstimated: 0, creditsReported: null,
    providerResourceId: null, endpoint: null, provenance: {}, createdAt: new Date(), completedAt: new Date(), ...over,
  };
}

describe('contact enrichment persistence (PostgreSQL)', () => {
  let handle: DbHandle;
  beforeEach(async () => { handle ??= testDatabase.createHandle(); await testDatabase.truncate(handle.db); });
  afterAll(async () => { if (handle) await handle.pool.end(); });

  async function seedLead(): Promise<string> {
    const id = randomUUID();
    await handle.db.insert(leads).values({ id, normalizedDomain: DOMAIN, status: 'READY_FOR_HUMAN_APPROVAL' });
    return id;
  }

  it('persists a VERIFIED run with reported credits and reads it back', async () => {
    const leadId = await seedLead();
    const repo = new ContactEnrichmentRepository(handle.db);
    await repo.save(baseResult(leadId, {
      inputHash: 'h1', outcome: 'VERIFIED', creditsEstimated: 1, creditsReported: 1, endpoint: '/supersearch-enrichment/enrich-leads-from-supersearch',
      accepted: { fullName: 'Shyam Shastri', title: 'Principal Dentist', email: `shyam@${DOMAIN}`, verificationStatus: 'VERIFIED', dataQuality: 'high', confidence: 0.98 },
    }));
    const found = await repo.findByInputHash(leadId, 'mock', 'ENRICH', 'h1');
    expect(found?.outcome).toBe('VERIFIED');
    expect(found?.accepted?.email).toBe(`shyam@${DOMAIN}`);
    expect(found?.creditsEstimated).toBe(1);
    expect(found?.creditsReported).toBe(1);
  });

  it('persists a PREVIEW_MATCHED row with NO reported credits (migration 0040 outcomes + honest credits)', async () => {
    const leadId = await seedLead();
    const repo = new ContactEnrichmentRepository(handle.db);
    await repo.save(baseResult(leadId, { inputHash: 'h2', mode: 'PREVIEW', outcome: 'PREVIEW_MATCHED', creditsEstimated: 0, creditsReported: null }));
    const found = await repo.findByInputHash(leadId, 'mock', 'PREVIEW', 'h2');
    expect(found?.outcome).toBe('PREVIEW_MATCHED');
    expect(found?.creditsReported).toBeNull();
  });

  it('enforces idempotency on (lead, provider, mode, input_hash)', async () => {
    const leadId = await seedLead();
    const repo = new ContactEnrichmentRepository(handle.db);
    await repo.save(baseResult(leadId, { inputHash: 'dup' }));
    await expect(repo.save(baseResult(leadId, { inputHash: 'dup' }))).rejects.toThrow();
  });

  it('mode is part of the idempotency key: same input_hash but different mode is NOT a duplicate', async () => {
    const leadId = await seedLead();
    const repo = new ContactEnrichmentRepository(handle.db);
    await repo.save(baseResult(leadId, { inputHash: 'same-hash', mode: 'ENRICH', outcome: 'NOT_FOUND' }));
    await expect(repo.save(baseResult(leadId, { inputHash: 'same-hash', mode: 'PREVIEW', outcome: 'PREVIEW_NO_MATCH' }))).resolves.not.toThrow();
    const enrichRow = await repo.findByInputHash(leadId, 'mock', 'ENRICH', 'same-hash');
    const previewRow = await repo.findByInputHash(leadId, 'mock', 'PREVIEW', 'same-hash');
    expect(enrichRow?.outcome).toBe('NOT_FOUND');
    expect(previewRow?.outcome).toBe('PREVIEW_NO_MATCH');
  });

  it('save with { overwrite: true } replaces the existing row in place (force-refresh) instead of throwing a duplicate-key error', async () => {
    const leadId = await seedLead();
    const repo = new ContactEnrichmentRepository(handle.db);
    await repo.save(baseResult(leadId, { inputHash: 'force-refresh-hash', outcome: 'NOT_FOUND' }));
    const before = await repo.findByInputHash(leadId, 'mock', 'ENRICH', 'force-refresh-hash');
    await repo.save(
      baseResult(leadId, {
        inputHash: 'force-refresh-hash', outcome: 'VERIFIED', creditsEstimated: 2, creditsReported: null,
        accepted: { fullName: 'Shaimil Patel', title: 'Clinical Director', email: `shaimil@${DOMAIN}`, verificationStatus: 'VERIFIED', dataQuality: null, confidence: 0.9 },
      }),
      { overwrite: true },
    );
    const after = await repo.findByInputHash(leadId, 'mock', 'ENRICH', 'force-refresh-hash');
    expect(before?.outcome).toBe('NOT_FOUND');
    expect(after?.outcome).toBe('VERIFIED');
    expect(after?.accepted?.email).toBe(`shaimil@${DOMAIN}`);
    expect(after?.id).toBe(before?.id); // the original row's id is preserved; only its other columns changed
  });

  it('CHECK rejects a VERIFIED row without an email', async () => {
    const leadId = await seedLead();
    const repo = new ContactEnrichmentRepository(handle.db);
    await expect(repo.save(baseResult(leadId, { inputHash: 'bad', outcome: 'VERIFIED', accepted: null }))).rejects.toThrow();
  });

  it('CHECK rejects a PREVIEW-mode row with an ENRICH-only outcome', async () => {
    const leadId = await seedLead();
    const repo = new ContactEnrichmentRepository(handle.db);
    await expect(repo.save(baseResult(leadId, { inputHash: 'mode-bad', mode: 'PREVIEW', outcome: 'NOT_FOUND' }))).rejects.toThrow();
  });

  it('service preview→match→enrich persists VERIFIED and is idempotent against the real DB', async () => {
    const leadId = await seedLead();
    const repo = new ContactEnrichmentRepository(handle.db);
    const previewPerson: PreviewPerson = { name: 'Shyam Shastri', firstName: 'Shyam', lastName: 'Shastri', domain: DOMAIN, title: 'Principal Dentist', providerLeadId: 'L' };
    const preview = (): PreviewResult => ({ domain: DOMAIN, people: [previewPerson], creditsReported: null, resourceId: 'prev', endpoint: 'mock://preview', rawDigest: 'd' });
    const enrich = (q: EnrichmentQuery): ProviderEnrichmentOutcome => ({
      query: q, email: q.lastName === 'Shastri' ? `shyam@${q.domain}` : null,
      returnedIdentity: q.lastName === 'Shastri' ? { name: q.fullName, firstName: q.firstName, lastName: q.lastName, domain: q.domain, title: q.title } : null,
      verificationStatus: q.lastName === 'Shastri' ? 'VERIFIED' : 'NOT_FOUND', dataQuality: 'high', confidence: 0.98,
      creditsReported: 1, resourceId: 'job', endpoint: '/supersearch-enrichment/enrich-leads-from-supersearch', rawDigest: 'd',
    });
    const service = new ContactEnrichmentService({ provider: new MockContactEnrichmentProvider(enrich, preview), store: repo, logger });
    const r1 = await service.run(leadId, DOMAIN, CANDIDATES, caps, { performEnrichment: true });
    const r2 = await service.run(leadId, DOMAIN, CANDIDATES, caps, { performEnrichment: true });
    expect(r1.outcome).toBe('VERIFIED');
    expect(r1.creditsReported).toBe(1);
    expect(r2.id).toBe(r1.id);
    expect((await repo.findByInputHash(leadId, 'mock', 'ENRICH', computeInputHash('ENRICH', 'mock', DOMAIN, CANDIDATES)))?.id).toBe(r1.id);
  });

  it('ENRICH then PREVIEW against the real DB are distinct: a stale ENRICH NOT_FOUND never suppresses a later PREVIEW', async () => {
    const leadId = await seedLead();
    const repo = new ContactEnrichmentRepository(handle.db);
    const previewPerson: PreviewPerson = { name: 'Shyam Shastri', firstName: 'Shyam', lastName: 'Shastri', domain: DOMAIN, title: 'Principal Dentist', providerLeadId: 'L' };
    const preview = (): PreviewResult => ({ domain: DOMAIN, people: [previewPerson], creditsReported: null, resourceId: 'prev', endpoint: 'mock://preview', rawDigest: 'd' });
    const noEnrich = (q: EnrichmentQuery): ProviderEnrichmentOutcome => ({
      query: q, email: null, returnedIdentity: null, verificationStatus: 'NOT_FOUND', dataQuality: null, confidence: null,
      creditsReported: null, resourceId: 'job', endpoint: '/supersearch-enrichment/enrich-leads-from-supersearch', rawDigest: 'd',
    });
    const service = new ContactEnrichmentService({ provider: new MockContactEnrichmentProvider(noEnrich, preview), store: repo, logger });
    const enrichResult = await service.run(leadId, DOMAIN, CANDIDATES, caps, { performEnrichment: true });
    expect(enrichResult.outcome).toBe('NOT_FOUND');
    const previewResult = await service.run(leadId, DOMAIN, CANDIDATES, caps, { performEnrichment: false });
    expect(previewResult.id).not.toBe(enrichResult.id);
    expect(previewResult.mode).toBe('PREVIEW');
    expect(previewResult.outcome).toBe('PREVIEW_MATCHED');
    expect(previewResult.creditsEstimated).toBe(0);
  });

  describe('DOMAIN_SEARCH_ONLY mode (guarded Hunter-only Finder-tier bypass, migration 0042)', () => {
    it('persists a DOMAIN_SEARCH_ONLY VERIFIED row and reads it back', async () => {
      const leadId = await seedLead();
      const repo = new ContactEnrichmentRepository(handle.db);
      await repo.save(baseResult(leadId, {
        inputHash: 'ds1', mode: 'DOMAIN_SEARCH_ONLY', outcome: 'VERIFIED', creditsEstimated: 1, creditsReported: null,
        accepted: { fullName: 'Shaimil Patel', title: 'Clinical Director', email: `shaimil@${DOMAIN}`, verificationStatus: 'VERIFIED', dataQuality: null, confidence: 0.9 },
      }));
      const found = await repo.findByInputHash(leadId, 'mock', 'DOMAIN_SEARCH_ONLY', 'ds1');
      expect(found?.mode).toBe('DOMAIN_SEARCH_ONLY');
      expect(found?.outcome).toBe('VERIFIED');
      expect(found?.accepted?.email).toBe(`shaimil@${DOMAIN}`);
    });

    it.each(['VERIFIED', 'NOT_FOUND', 'CAPPED', 'ERROR'] as const)('CHECK accepts DOMAIN_SEARCH_ONLY + %s', async (outcome) => {
      const leadId = await seedLead();
      const repo = new ContactEnrichmentRepository(handle.db);
      await expect(
        repo.save(baseResult(leadId, {
          inputHash: `ds-ok-${outcome}`, mode: 'DOMAIN_SEARCH_ONLY', outcome,
          accepted: outcome === 'VERIFIED'
            ? { fullName: 'Shaimil Patel', title: 'Clinical Director', email: `shaimil@${DOMAIN}`, verificationStatus: 'VERIFIED', dataQuality: null, confidence: 0.9 }
            : null,
        })),
      ).resolves.not.toThrow();
    });

    it('CHECK rejects a DOMAIN_SEARCH_ONLY row with a PREVIEW-only outcome (PREVIEW_MATCHED)', async () => {
      const leadId = await seedLead();
      const repo = new ContactEnrichmentRepository(handle.db);
      await expect(
        repo.save(baseResult(leadId, { inputHash: 'ds-bad', mode: 'DOMAIN_SEARCH_ONLY', outcome: 'PREVIEW_MATCHED' })),
      ).rejects.toThrow();
    });

    it('is idempotent against the real DB: two runDomainSearchOnly calls with identical inputs return the same row', async () => {
      const leadId = await seedLead();
      const repo = new ContactEnrichmentRepository(handle.db);
      let calls = 0;
      const provider: ContactEnrichmentProvider = {
        name: 'hunter',
        preview: () => { throw new Error('preview must never be called in domain-search-only mode'); },
        estimate: () => { throw new Error('estimate must never be called'); },
        enrich: () => { throw new Error('enrich (Finder) must never be called in domain-search-only mode'); },
        domainSearch: (domain: string): Promise<DomainSearchResult> => {
          calls += 1;
          return Promise.resolve({ domain, people: [], creditsReported: null, creditsUsed: 0, endpoint: 'mock://domain-search', rawDigest: 'd' });
        },
      };
      const service = new ContactEnrichmentService({ provider, store: repo, logger });
      const dsCaps: EnrichmentRunCaps = { maxRequests: 1, maxCredits: 2, minCreditsPerLookup: 1 };
      const r1 = await service.runDomainSearchOnly(leadId, DOMAIN, CANDIDATES, dsCaps, {});
      const r2 = await service.runDomainSearchOnly(leadId, DOMAIN, CANDIDATES, dsCaps, {});
      expect(r1.mode).toBe('DOMAIN_SEARCH_ONLY');
      expect(r2.id).toBe(r1.id);
      expect(calls).toBe(1);
    });
  });
});
