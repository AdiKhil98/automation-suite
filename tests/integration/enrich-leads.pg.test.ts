import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { requireIntegrationTestDatabase } from '../support/test-database.js';
import {
  EnrichmentService,
  type EnrichmentTxRepos,
  type EnrichmentUnitOfWork,
} from '../../src/domain/enrichment/enrichment-service.js';
import { type Candidate, type EnrichmentContext } from '../../src/domain/enrichment/types.js';
import { buildCandidateLead } from '../../src/domain/leads/lead-factory.js';
import { LeadService } from '../../src/domain/leads/lead-service.js';
import {
  FactsContextProvider,
  GoogleContextProvider,
  type GoogleReadBudget,
} from '../../src/integrations/enrichment/context-providers.js';
import { type PlacesDetailsClient } from '../../src/integrations/enrichment/google-places-details.js';
import { HttpWebsiteVerifier } from '../../src/integrations/enrichment/http-website-verifier.js';
import { MockPageFetcher } from '../../src/integrations/enrichment/mock-page-fetcher.js';
import {
  type CandidateProvider,
  type LeadEnrichmentInput,
} from '../../src/integrations/enrichment/provider.js';
import { type FetchOutcome } from '../../src/utils/safe-fetch.js';
import { type DbHandle } from '../../src/persistence/db.js';
import { DrizzleEnrichmentUnitOfWork } from '../../src/persistence/enrichment-unit-of-work.js';
import { EnrichmentRepository } from '../../src/persistence/repositories/enrichment.repo.js';
import { LeadFactsRepository } from '../../src/persistence/repositories/lead-facts.repo.js';
import { LeadsRepository } from '../../src/persistence/repositories/leads.repo.js';
import { PipelineRepository } from '../../src/persistence/repositories/pipeline.repo.js';
import { PipelineRunsRepository } from '../../src/persistence/repositories/runs.repo.js';
import {
  enrichmentAttempts,
  enrichmentCandidates,
  enrichmentSignals,
  leadFacts,
  pipelineEvents,
} from '../../src/persistence/schema.js';

const testDatabase = requireIntegrationTestDatabase();
const logger = pino({ level: 'silent' });
const VERIFY = { minConfidence: 0.6, ambiguousMargin: 0.1 };

function site(name: string, tel: string, city: string, address: string): string {
  return `<!doctype html><html><head><title>${name}</title></head><body>
    <h1>${name}</h1><p>${city}. ${address}</p>
    <p><a href="tel:${tel.replace(/\s/g, '')}">${tel}</a></p>
    <a href="/contact">Contact</a>
    <script type="application/ld+json">${JSON.stringify({ '@type': 'Dentist', name, telephone: tel, address: { streetAddress: address, addressLocality: city } })}</script>
    <footer>${name} Ltd — ${city}</footer></body></html>`;
}

class FixedCandidates implements CandidateProvider {
  readonly name = 'mock';
  readonly capabilities = { returnsFields: ['url'], persistableFields: ['url'], ephemeralFields: [], canIncurCost: false };
  constructor(private readonly urls: string[]) {}
  async candidatesFor(_i: LeadEnrichmentInput, ctx: EnrichmentContext): Promise<Candidate[]> {
    const all = [...this.urls, ...(ctx.candidateUrls ?? [])];
    return all.map((url) => ({ url, discoverySource: 'mock' as const }));
  }
}

describe('enrichLead (PostgreSQL)', () => {
  let handle: DbHandle;

  beforeEach(async () => {
    handle ??= testDatabase.createHandle();
    await testDatabase.truncate(handle.db);
  });
  afterAll(async () => {
    if (handle) await handle.pool.end();
  });

  async function seed(facts: Array<{ factType: string; value: string; normalized: string | null; source: 'mock' | 'manual' | 'website' }>): Promise<string> {
    const leads = new LeadsRepository(handle.db);
    const factsRepo = new LeadFactsRepository(handle.db);
    const lead = buildCandidateLead({ sourcePlaceId: `place-${randomUUID()}`, source: 'mock' });
    await leads.create(lead);
    for (const f of facts) {
      await factsRepo.writeCurrentFact({
        leadId: lead.id,
        factType: f.factType as never,
        value: f.value,
        normalizedValue: f.normalized,
        sourceType: f.source,
        sourceUrl: null,
      });
    }
    await leads.updateStatus(lead.id, 'READY_FOR_ENRICHMENT', new Date());
    return lead.id;
  }

  async function inputFor(leadId: string): Promise<LeadEnrichmentInput> {
    const lead = await new LeadsRepository(handle.db).getById(leadId);
    return {
      leadId,
      placeId: lead?.placeId ?? null,
      currentFacts: await new LeadFactsRepository(handle.db).listCurrentFacts(leadId),
    };
  }

  function service(
    pages: Map<string, string | FetchOutcome>,
    candidateUrls: string[],
    uow: EnrichmentUnitOfWork = new DrizzleEnrichmentUnitOfWork(handle.db),
    contextProviderOverride?: ConstructorParameters<typeof EnrichmentService>[0]['contextProvider'],
  ): EnrichmentService {
    const facts = new FactsContextProvider();
    return new EnrichmentService({
      contextProvider: contextProviderOverride ?? facts,
      factsContextProvider: facts,
      candidateProvider: new FixedCandidates(candidateUrls),
      verifier: new HttpWebsiteVerifier(new MockPageFetcher(pages), { ...VERIFY, maxPages: 5 }),
      uow,
      logger,
    });
  }

  async function run(svc: EnrichmentService, leadId: string): Promise<string> {
    const runId = await new PipelineRunsRepository(handle.db).start('enrich:test', true);
    const r = await svc.enrich(await inputFor(leadId), runId, VERIFY);
    return r.outcome;
  }

  const STRONG_FACTS = [
    { factType: 'business_name', value: 'Acme Dental', normalized: 'acme dental', source: 'mock' as const },
    { factType: 'phone', value: '0161 496 0000', normalized: '1614960000', source: 'mock' as const },
    { factType: 'formatted_address', value: '1 Main St, Manchester', normalized: '1 main st manchester', source: 'mock' as const },
    { factType: 'city', value: 'Manchester', normalized: 'manchester', source: 'mock' as const },
  ];

  it('VERIFIED: writes website facts, signals, and routes to READY_FOR_QUALIFICATION', async () => {
    const id = await seed(STRONG_FACTS);
    const url = 'https://acmedental.example';
    const pages = new Map<string, string | FetchOutcome>([[url, site('Acme Dental', '+44 161 496 0000', 'Manchester', '1 Main St')]]);
    expect(await run(service(pages, [url]), id)).toBe('VERIFIED');

    expect((await new LeadsRepository(handle.db).getById(id))?.status).toBe('READY_FOR_QUALIFICATION');
    const facts = await new LeadFactsRepository(handle.db).listCurrentFacts(id);
    const official = facts.find((f) => f.factType === 'official_domain');
    expect(official?.sourceType).toBe('website');
    expect(official?.value).toBe('acmedental.example');
    const attempts = await handle.db.select().from(enrichmentAttempts).where(eq(enrichmentAttempts.leadId, id));
    expect(attempts[0]?.outcome).toBe('VERIFIED');
    expect(attempts[0]?.chosenDomain).toBe('acmedental.example');
    const sigs = await handle.db.select().from(enrichmentSignals);
    expect(sigs.some((s) => s.matchedFactId !== null)).toBe(true);
  });

  it('routes the full outcome taxonomy to the correct lead state', async () => {
    // INSUFFICIENT_CONTEXT: no facts at all.
    const idA = await seed([]);
    expect(await run(service(new Map(), []), idA)).toBe('INSUFFICIENT_CONTEXT');
    expect((await new LeadsRepository(handle.db).getById(idA))?.status).toBe('READY_FOR_ENRICHMENT');

    // NO_CANDIDATE: context but no candidate URLs.
    const idB = await seed(STRONG_FACTS);
    expect(await run(service(new Map(), []), idB)).toBe('NO_CANDIDATE');
    expect((await new LeadsRepository(handle.db).getById(idB))?.status).toBe('READY_FOR_ENRICHMENT');

    // NO_VERIFIED_CANDIDATE: directory host.
    const idC = await seed(STRONG_FACTS);
    const dir = 'https://facebook.com/acme';
    expect(await run(service(new Map([[dir, site('Acme', '+44 161 496 0000', 'Manchester', '1 Main St')]]), [dir]), idC)).toBe('NO_VERIFIED_CANDIDATE');
    expect((await new LeadsRepository(handle.db).getById(idC))?.status).toBe('NEEDS_MANUAL_REVIEW');

    // BROWSER_REQUIRED: client-rendered shell.
    const idD = await seed(STRONG_FACTS);
    const shellUrl = 'https://shell.example';
    const shell = '<html><body><div id="root"></div><script src=a></script><script src=b></script><script src=c></script><script src=d></script><script src=e></script></body></html>';
    expect(await run(service(new Map([[shellUrl, shell]]), [shellUrl]), idD)).toBe('BROWSER_REQUIRED');
    expect((await new LeadsRepository(handle.db).getById(idD))?.status).toBe('NEEDS_MANUAL_REVIEW');

    // POLICY_BLOCKED.
    const idE = await seed(STRONG_FACTS);
    const pol = 'https://blocked.example';
    expect(await run(service(new Map<string, string | FetchOutcome>([[pol, { kind: 'policy_blocked', reason: 'ssrf' }]]), [pol]), idE)).toBe('POLICY_BLOCKED');
    expect((await new LeadsRepository(handle.db).getById(idE))?.status).toBe('NEEDS_MANUAL_REVIEW');

    // TRANSIENT_ERROR: remains READY_FOR_ENRICHMENT.
    const idF = await seed(STRONG_FACTS);
    const tr = 'https://down.example';
    expect(await run(service(new Map<string, string | FetchOutcome>([[tr, { kind: 'transient', reason: 'timeout' }]]), [tr]), idF)).toBe('TRANSIENT_ERROR');
    expect((await new LeadsRepository(handle.db).getById(idF))?.status).toBe('READY_FOR_ENRICHMENT');

    // INVALID_INPUT: unparseable candidate URL.
    const idG = await seed(STRONG_FACTS);
    expect(await run(service(new Map(), ['not a url']), idG)).toBe('INVALID_INPUT');
    expect((await new LeadsRepository(handle.db).getById(idG))?.status).toBe('NEEDS_MANUAL_REVIEW');
  });

  it('preserves a manual fact on conflict and routes to manual review', async () => {
    const id = await seed([
      ...STRONG_FACTS,
      { factType: 'business_name', value: 'Manual Name', normalized: 'manual name', source: 'manual' },
    ]);
    const url = 'https://acmedental.example';
    // Site verifies via phone, but its structured name differs from the manual name.
    const pages = new Map<string, string | FetchOutcome>([[url, site('Website Name', '+44 161 496 0000', 'Manchester', '1 Main St')]]);
    expect(await run(service(pages, [url]), id)).toBe('VERIFIED');
    expect((await new LeadsRepository(handle.db).getById(id))?.status).toBe('NEEDS_MANUAL_REVIEW');
    const name = (await new LeadFactsRepository(handle.db).getCurrentFact(id, 'business_name'));
    expect(name?.sourceType).toBe('manual');
    expect(name?.value).toBe('Manual Name');
  });

  it('rolls back the entire enrichment write if any step fails', async () => {
    const id = await seed(STRONG_FACTS);
    const url = 'https://acmedental.example';
    const pages = new Map<string, string | FetchOutcome>([[url, site('Acme Dental', '+44 161 496 0000', 'Manchester', '1 Main St')]]);
    // UoW that fails when recording the final event, after facts/attempt were written.
    const failingUow: EnrichmentUnitOfWork = {
      transaction: (fn) =>
        handle.db.transaction(async (tx) => {
          const leads = new LeadsRepository(tx);
          const repos: EnrichmentTxRepos = {
            leads,
            leadService: new LeadService(leads, new PipelineRepository(tx)),
            facts: new LeadFactsRepository(tx),
            enrichment: new EnrichmentRepository(tx),
            events: {
              record: async () => {
                throw new Error('injected failure after writes');
              },
            },
          };
          return fn(repos);
        }),
    };
    await expect(run(service(pages, [url], failingUow), id)).rejects.toThrow(/injected failure/);

    expect(await handle.db.select().from(enrichmentAttempts)).toHaveLength(0);
    expect(await handle.db.select().from(enrichmentCandidates)).toHaveLength(0);
    const official = await new LeadFactsRepository(handle.db).getCurrentFact(id, 'official_domain');
    expect(official).toBeNull();
    expect((await new LeadsRepository(handle.db).getById(id))?.status).toBe('READY_FOR_ENRICHMENT');
  });

  it('never persists provider-restricted Google context', async () => {
    const SECRET = 'SECRET-GOOGLE-DISPLAYNAME';
    const url = 'https://acmedental.example';
    const googleClient: PlacesDetailsClient = {
      details: async () => ({ displayName: SECRET, formattedAddress: 'SECRET ADDR', nationalPhoneNumber: '+44 161 496 0000', websiteUri: url }),
    };
    const budget: GoogleReadBudget = { requests: 0, estimatedCostUsd: 0, maxRequests: 10, maxCostUsd: 1 };
    const googleProvider = new GoogleContextProvider({ client: googleClient, allowPaidReads: true, budget, logger });
    // Lead is Place-ID-only (no durable facts); Google supplies in-memory context.
    const id = await seed([]);
    // Website content controls what gets stored (does NOT contain the secret).
    const pages = new Map<string, string | FetchOutcome>([[url, site('Acme Dental', '+44 161 496 0000', 'Manchester', '1 Main St')]]);
    const outcome = await run(service(pages, [], new DrizzleEnrichmentUnitOfWork(handle.db), googleProvider), id);
    expect(outcome).toBe('VERIFIED');

    const dump = JSON.stringify([
      await handle.db.select().from(leadFacts),
      await handle.db.select().from(enrichmentAttempts),
      await handle.db.select().from(enrichmentCandidates),
      await handle.db.select().from(enrichmentSignals),
      await handle.db.select().from(pipelineEvents),
    ]);
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain('SECRET ADDR');
  });
});
