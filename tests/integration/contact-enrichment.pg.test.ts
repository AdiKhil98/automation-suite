import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { type Logger } from 'pino';
import { requireIntegrationTestDatabase } from '../support/test-database.js';
import { type DbHandle } from '../../src/persistence/db.js';
import { leads } from '../../src/persistence/schema.js';
import { ContactEnrichmentRepository } from '../../src/persistence/repositories/contact-enrichment.repo.js';
import { ContactEnrichmentService, computeInputHash, type EnrichmentRunCaps } from '../../src/domain/contact-enrichment/service.js';
import { MockContactEnrichmentProvider } from '../../src/integrations/contact-enrichment/mock-provider.js';
import { type CandidatePerson, type ContactEnrichmentResult, type EnrichmentQuery, type PreviewPerson, type PreviewResult, type ProviderEnrichmentOutcome } from '../../src/domain/contact-enrichment/types.js';

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
    id: randomUUID(), leadId, provider: 'mock', inputHash: randomUUID(), requestedDomain: DOMAIN,
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
    const found = await repo.findByInputHash(leadId, 'mock', 'h1');
    expect(found?.outcome).toBe('VERIFIED');
    expect(found?.accepted?.email).toBe(`shyam@${DOMAIN}`);
    expect(found?.creditsEstimated).toBe(1);
    expect(found?.creditsReported).toBe(1);
  });

  it('persists a PREVIEW_MATCHED row with NO reported credits (migration 0040 outcomes + honest credits)', async () => {
    const leadId = await seedLead();
    const repo = new ContactEnrichmentRepository(handle.db);
    await repo.save(baseResult(leadId, { inputHash: 'h2', outcome: 'PREVIEW_MATCHED', creditsEstimated: 0, creditsReported: null }));
    const found = await repo.findByInputHash(leadId, 'mock', 'h2');
    expect(found?.outcome).toBe('PREVIEW_MATCHED');
    expect(found?.creditsReported).toBeNull();
  });

  it('enforces idempotency on (lead, provider, input_hash)', async () => {
    const leadId = await seedLead();
    const repo = new ContactEnrichmentRepository(handle.db);
    await repo.save(baseResult(leadId, { inputHash: 'dup' }));
    await expect(repo.save(baseResult(leadId, { inputHash: 'dup' }))).rejects.toThrow();
  });

  it('CHECK rejects a VERIFIED row without an email', async () => {
    const leadId = await seedLead();
    const repo = new ContactEnrichmentRepository(handle.db);
    await expect(repo.save(baseResult(leadId, { inputHash: 'bad', outcome: 'VERIFIED', accepted: null }))).rejects.toThrow();
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
    expect((await repo.findByInputHash(leadId, 'mock', computeInputHash('mock', DOMAIN, CANDIDATES)))?.id).toBe(r1.id);
  });
});
