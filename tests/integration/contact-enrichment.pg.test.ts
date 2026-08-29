import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { type Logger } from 'pino';
import { requireIntegrationTestDatabase } from '../support/test-database.js';
import { type DbHandle } from '../../src/persistence/db.js';
import { leads } from '../../src/persistence/schema.js';
import { ContactEnrichmentRepository } from '../../src/persistence/repositories/contact-enrichment.repo.js';
import { ContactEnrichmentService, computeInputHash, type EnrichmentRunCaps } from '../../src/domain/contact-enrichment/service.js';
import { MockContactEnrichmentProvider } from '../../src/integrations/contact-enrichment/mock-provider.js';
import { type CandidatePerson, type ContactEnrichmentResult, type EnrichmentQuery, type ProviderEnrichmentOutcome } from '../../src/domain/contact-enrichment/types.js';

const testDatabase = requireIntegrationTestDatabase();
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;
const caps: EnrichmentRunCaps = { maxRequests: 3, maxCredits: 3, minCreditsPerLookup: 1 };

const CANDIDATES: CandidatePerson[] = [
  { fullName: 'Shyam Shastri', firstName: 'Shyam', lastName: 'Shastri', title: 'Principal Dentist', priority: 1 },
  { fullName: 'Shaimil Patel', firstName: 'Shaimil', lastName: 'Patel', title: 'Clinical Director', priority: 2 },
];

function baseResult(leadId: string, over: Partial<ContactEnrichmentResult>): ContactEnrichmentResult {
  return {
    id: randomUUID(), leadId, provider: 'mock', inputHash: randomUUID(), requestedDomain: 'diamond-smile.com',
    candidates: CANDIDATES, outcome: 'NOT_FOUND', accepted: null, creditsUsed: 0, providerResourceId: null,
    endpoint: null, provenance: {}, createdAt: new Date(), completedAt: new Date(), ...over,
  };
}

describe('contact enrichment persistence (PostgreSQL)', () => {
  let handle: DbHandle;

  beforeEach(async () => {
    handle ??= testDatabase.createHandle();
    await testDatabase.truncate(handle.db);
  });
  afterAll(async () => { if (handle) await handle.pool.end(); });

  async function seedLead(): Promise<string> {
    const id = randomUUID();
    await handle.db.insert(leads).values({ id, normalizedDomain: 'diamond-smile.com', status: 'READY_FOR_HUMAN_APPROVAL' });
    return id;
  }

  it('persists a VERIFIED run and reads it back by input hash', async () => {
    const leadId = await seedLead();
    const repo = new ContactEnrichmentRepository(handle.db);
    const result = baseResult(leadId, {
      inputHash: 'hash-1', outcome: 'VERIFIED', creditsUsed: 1, endpoint: '/supersearch-enrichments',
      accepted: { fullName: 'Shyam Shastri', title: 'Principal Dentist', email: 'shyam@diamond-smile.com', verificationStatus: 'VERIFIED', dataQuality: 'high', confidence: 0.98 },
    });
    await repo.save(result);
    const found = await repo.findByInputHash(leadId, 'mock', 'hash-1');
    expect(found?.outcome).toBe('VERIFIED');
    expect(found?.accepted?.email).toBe('shyam@diamond-smile.com');
    expect(found?.accepted?.verificationStatus).toBe('VERIFIED');
  });

  it('enforces idempotency on (lead, provider, input_hash)', async () => {
    const leadId = await seedLead();
    const repo = new ContactEnrichmentRepository(handle.db);
    await repo.save(baseResult(leadId, { inputHash: 'dup', outcome: 'NOT_FOUND' }));
    await expect(repo.save(baseResult(leadId, { inputHash: 'dup', outcome: 'NOT_FOUND' }))).rejects.toThrow();
  });

  it('CHECK rejects a VERIFIED row without an email, and a non-VERIFIED row with an email', async () => {
    const leadId = await seedLead();
    const repo = new ContactEnrichmentRepository(handle.db);
    // VERIFIED requires an accepted email — accepted is null here, so save must fail.
    await expect(repo.save(baseResult(leadId, { inputHash: 'a', outcome: 'VERIFIED', accepted: null }))).rejects.toThrow();
    // NOT_FOUND with an email is contradictory — construct the row shape directly to bypass repo mapping.
    const bad = baseResult(leadId, { inputHash: 'b', outcome: 'NOT_FOUND', accepted: { fullName: 'X', title: 'Y', email: 'x@d.com', verificationStatus: 'VERIFIED', dataQuality: null, confidence: null } });
    await expect(repo.save(bad)).rejects.toThrow();
  });

  it('service run persists and is idempotent against the real DB', async () => {
    const leadId = await seedLead();
    const repo = new ContactEnrichmentRepository(handle.db);
    const responder = (q: EnrichmentQuery): ProviderEnrichmentOutcome => ({
      query: q, email: q.lastName === 'Shastri' ? `shyam@${q.domain}` : null,
      returnedIdentity: q.lastName === 'Shastri' ? { name: q.fullName, firstName: q.firstName, lastName: q.lastName, domain: q.domain, title: q.title } : null,
      verificationStatus: q.lastName === 'Shastri' ? 'VERIFIED' : 'NOT_FOUND',
      dataQuality: 'high', confidence: 0.98, creditsUsed: 1, resourceId: 'job', endpoint: '/supersearch-enrichment/enrich-leads-from-supersearch', rawDigest: 'd',
    });
    const service = new ContactEnrichmentService({ provider: new MockContactEnrichmentProvider(responder), store: repo, logger });
    const r1 = await service.run(leadId, 'diamond-smile.com', CANDIDATES, caps);
    const r2 = await service.run(leadId, 'diamond-smile.com', CANDIDATES, caps);
    expect(r1.outcome).toBe('VERIFIED');
    expect(r2.id).toBe(r1.id);
    const hash = computeInputHash('mock', 'diamond-smile.com', CANDIDATES);
    expect((await repo.findByInputHash(leadId, 'mock', hash))?.id).toBe(r1.id);
  });
});
