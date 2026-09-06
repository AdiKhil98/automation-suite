import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Logger } from 'pino';
import { requireIntegrationTestDatabase } from '../support/test-database.js';
import { type DbHandle } from '../../src/persistence/db.js';
import { leads } from '../../src/persistence/schema.js';
import { contactResolveBatchCommand } from '../../src/cli/commands/contact-resolve-batch.js';
import { type CliContext } from '../../src/cli/context.js';
import { LeadFactsRepository } from '../../src/persistence/repositories/lead-facts.repo.js';
import { LeadsRepository } from '../../src/persistence/repositories/leads.repo.js';
import { PipelineRepository } from '../../src/persistence/repositories/pipeline.repo.js';
import { ContactEnrichmentRepository } from '../../src/persistence/repositories/contact-enrichment.repo.js';
import { ContactResolutionRepository } from '../../src/persistence/repositories/contact-resolution.repo.js';
import { type ContactEnrichmentProvider } from '../../src/domain/contact-enrichment/provider.js';
import { computeInputHash } from '../../src/domain/contact-enrichment/service.js';
import { type ResolveCascadeProvider } from '../../src/domain/contact-resolve-batch/eligibility.js';
import { buildCandidatePerson } from '../../src/domain/contact-enrichment/candidate-parsing.js';
import { type EnrichmentQuery, type PreviewPerson } from '../../src/domain/contact-enrichment/types.js';

/**
 * End-to-end persistence contract for the GENERIC_OFFICIAL fallback, against real PostgreSQL:
 * the CHECK constraints, the one-current-row index, and the Complete Dentistry scenario driven
 * through the actual CLI command.
 */

const testDatabase = requireIntegrationTestDatabase();
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;
const DOMAIN = 'completedentistry.co.uk';
const CANDS = [{ fullName: 'Richard Clarke-Irons', title: 'Principal Dentist' }, { fullName: 'Sarah Lowe', title: 'Practice Manager' }];

const liveConfig = {
  DRY_RUN: false,
  CONTACT_ENRICHMENT_ENABLED: true,
  CONTACT_ENRICHMENT_MAX_REQUESTS_PER_RUN: 3,
  CONTACT_ENRICHMENT_MAX_CREDITS_PER_RUN: 3,
  CONTACT_RESOLVE_BATCH_MAX_LEADS_PER_RUN: 10,
  CONTACT_RESOLVE_BATCH_MAX_REQUESTS_PER_RUN: 20,
  CONTACT_RESOLVE_BATCH_MAX_CREDITS_PER_RUN: 10,
};

let tmpDir: string | null = null;
function writeCandidatesFile(byLead: Record<string, Array<{ fullName: string; title: string }>>): string {
  tmpDir = mkdtempSync(join(tmpdir(), 'contact-resolution-test-'));
  const path = join(tmpDir, 'candidates.json');
  writeFileSync(path, JSON.stringify(byLead), 'utf8');
  return path;
}
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

function fakeProvider(name: ResolveCascadeProvider, opts: { onEnrich?: () => void; verified?: boolean } = {}): ContactEnrichmentProvider {
  return {
    name,
    preview: (domain, candidates = []) => {
      const people: PreviewPerson[] = candidates.map((c) => ({ name: c.fullName, firstName: c.firstName, lastName: c.lastName, domain, title: c.title, providerLeadId: null }));
      return Promise.resolve({ domain, people, creditsReported: null, resourceId: null, endpoint: `fake://${name}/preview`, rawDigest: 'd' });
    },
    estimate: (query) => Promise.resolve({ query, available: true, projectedCredits: 1, endpoint: `fake://${name}/estimate` }),
    enrich: (query: EnrichmentQuery) => {
      opts.onEnrich?.();
      if (opts.verified) {
        return Promise.resolve({
          query, email: `${query.firstName.toLowerCase()}@${DOMAIN}`,
          returnedIdentity: { name: query.fullName, firstName: query.firstName, lastName: query.lastName, domain: DOMAIN, title: query.title },
          verificationStatus: 'VERIFIED' as const, dataQuality: null, confidence: 0.9, creditsReported: null,
          resourceId: null, endpoint: 'fake://enrich', rawDigest: 'd', requestsUsed: 1, creditsUsed: 1,
        });
      }
      return Promise.resolve({
        query, email: null, returnedIdentity: null, verificationStatus: 'NOT_FOUND' as const, dataQuality: null,
        confidence: null, creditsReported: null, resourceId: null, endpoint: `fake://${name}/enrich`, rawDigest: 'd',
        requestsUsed: 1, creditsUsed: 0,
      });
    },
  };
}

describe('contact resolution / GENERIC_OFFICIAL fallback (PostgreSQL)', () => {
  let handle: DbHandle;
  beforeEach(async () => { handle ??= testDatabase.createHandle(); await testDatabase.truncate(handle.db); });
  afterAll(async () => { if (handle) await handle.pool.end(); });

  function ctx(overrides: Partial<typeof liveConfig> = {}): CliContext {
    return {
      config: { ...liveConfig, ...overrides } as unknown as CliContext['config'],
      logger,
      db: handle.db,
      leads: new LeadsRepository(handle.db),
      events: new PipelineRepository(handle.db),
      service: undefined as unknown as CliContext['service'],
    };
  }

  async function seedLead(domain = DOMAIN): Promise<string> {
    const id = randomUUID();
    await handle.db.insert(leads).values({ id, businessName: 'Complete Dentistry', normalizedDomain: domain, status: 'QUALIFIED' });
    await new PipelineRepository(handle.db).record({
      leadId: id, runId: null, type: 'STATE_TRANSITION', fromStatus: 'READY_FOR_QUALIFICATION', toStatus: 'QUALIFIED',
      message: 'READY_FOR_QUALIFICATION -> QUALIFIED', data: null,
    });
    await new LeadFactsRepository(handle.db).writeCurrentFact({
      leadId: id, factType: 'official_domain', value: domain, normalizedValue: domain, sourceType: 'manual', sourceUrl: null,
    });
    return id;
  }

  /** Persist a website-published contact_email fact, exactly as the capture pipeline would. */
  async function seedWebsiteContactEmail(leadId: string, email: string): Promise<void> {
    await new LeadFactsRepository(handle.db).writeCurrentFact({
      leadId, factType: 'contact_email', value: email, normalizedValue: email.toLowerCase(),
      sourceType: 'website', sourceUrl: `https://${DOMAIN}/contact`, confidence: 0.9,
    });
  }

  /** Persist the two ENRICH rows that make a personal cascade conclusively exhausted. */
  async function seedExhaustedChain(leadId: string): Promise<void> {
    const candidates = CANDS.map((c, i) => buildCandidatePerson(c.fullName, c.title, i + 1));
    const repo = new ContactEnrichmentRepository(handle.db);
    for (const provider of ['instantly', 'hunter'] as const) {
      await repo.save({
        id: randomUUID(), leadId, provider, mode: 'ENRICH',
        inputHash: computeInputHash('ENRICH', provider, DOMAIN, candidates),
        requestedDomain: DOMAIN, candidates, outcome: 'NOT_FOUND', accepted: null, creditsEstimated: 0,
        creditsReported: null, providerResourceId: null, endpoint: 'fake://enrich', provenance: {},
        createdAt: new Date(), completedAt: new Date(),
      });
    }
  }

  it('COMPLETE DENTISTRY: an exhausted personal chain resolves to GENERIC_OFFICIAL from the published fact, with zero provider calls', async () => {
    const leadId = await seedLead();
    await seedWebsiteContactEmail(leadId, 'info@completedentistry.co.uk');
    await seedExhaustedChain(leadId);
    const candidatesFile = writeCandidatesFile({ [leadId]: CANDS });

    let providerCalls = 0;
    await contactResolveBatchCommand(ctx(), { candidatesFile, confirm: true }, {
      buildProvider: (name) => fakeProvider(name, { onEnrich: () => { providerCalls += 1; } }),
    });

    // The fallback spends nothing: no enrich() ran, and no new enrichment row was written.
    expect(providerCalls).toBe(0);
    expect(await new ContactEnrichmentRepository(handle.db).listByLead(leadId)).toHaveLength(2);

    const resolution = await new ContactResolutionRepository(handle.db).getCurrent(leadId);
    expect(resolution?.resolutionType).toBe('GENERIC_OFFICIAL');
    expect(resolution?.recipientEmail).toBe('info@completedentistry.co.uk');
    expect(resolution?.sourceUrl).toBe(`https://${DOMAIN}/contact`);
    // Provenance points at the authoritative fact rather than duplicating it.
    const fact = await new LeadFactsRepository(handle.db).getCurrentFact(leadId, 'contact_email');
    expect(resolution?.sourceFactId).toBe(fact?.id);
    expect(resolution?.enrichmentResultId).toBeNull();
    // Names are carried as FORWARDING targets only.
    expect(resolution?.intendedDecisionMakers.map((d) => d.fullName)).toEqual(['Richard Clarke-Irons', 'Sarah Lowe']);
  });

  it('an exhausted chain with NO stored contact_email fact stays UNRESOLVED — no row, nothing guessed', async () => {
    const leadId = await seedLead();
    await seedExhaustedChain(leadId);
    const candidatesFile = writeCandidatesFile({ [leadId]: CANDS });
    await contactResolveBatchCommand(ctx(), { candidatesFile, confirm: true }, { buildProvider: (n) => fakeProvider(n) });
    expect(await new ContactResolutionRepository(handle.db).getCurrent(leadId)).toBeNull();
  });

  it('a denylisted or wrong-domain published inbox leaves the lead UNRESOLVED', async () => {
    for (const email of ['noreply@completedentistry.co.uk', 'careers@completedentistry.co.uk', 'info@some-agency.com']) {
      await testDatabase.truncate(handle.db);
      const leadId = await seedLead();
      await seedWebsiteContactEmail(leadId, email);
      await seedExhaustedChain(leadId);
      const candidatesFile = writeCandidatesFile({ [leadId]: CANDS });
      await contactResolveBatchCommand(ctx(), { candidatesFile, confirm: true }, { buildProvider: (n) => fakeProvider(n) });
      expect(await new ContactResolutionRepository(handle.db).getCurrent(leadId), email).toBeNull();
    }
  });

  it('a lead with cascade steps still pending runs the PERSONAL cascade and never falls back early', async () => {
    const leadId = await seedLead();
    await seedWebsiteContactEmail(leadId, 'info@completedentistry.co.uk');
    const candidatesFile = writeCandidatesFile({ [leadId]: CANDS });

    let enrichCalls = 0;
    await contactResolveBatchCommand(ctx(), { candidatesFile, confirm: true }, {
      buildProvider: (name) => fakeProvider(name, { onEnrich: () => { enrichCalls += 1; }, verified: name === 'instantly' }),
    });

    // Instantly verified a real person, so the generic inbox is never consulted.
    expect(enrichCalls).toBeGreaterThan(0);
    const resolution = await new ContactResolutionRepository(handle.db).getCurrent(leadId);
    expect(resolution?.resolutionType).toBe('PERSONAL_VERIFIED');
    expect(resolution?.recipientEmail).toBe(`richard@${DOMAIN}`);
    expect(resolution?.enrichmentResultId).not.toBeNull();
    expect(resolution?.sourceFactId).toBeNull();
    // PERSONAL_VERIFIED never carries a forwarding list.
    expect(resolution?.intendedDecisionMakers).toEqual([]);
  });

  it('PLAN mode writes no resolution at all', async () => {
    const leadId = await seedLead();
    await seedWebsiteContactEmail(leadId, 'info@completedentistry.co.uk');
    await seedExhaustedChain(leadId);
    const candidatesFile = writeCandidatesFile({ [leadId]: CANDS });
    await contactResolveBatchCommand(ctx(), { candidatesFile }, { buildProvider: (n) => fakeProvider(n) });
    expect(await new ContactResolutionRepository(handle.db).getCurrent(leadId)).toBeNull();
  });

  describe('database constraints', () => {
    it('rejects attaching a named decision-maker to a PERSONAL_VERIFIED row (contact_resolutions_intended_ck)', async () => {
      const leadId = await seedLead();
      const repo = new ContactResolutionRepository(handle.db);
      // Bypass the repo's own normalization by writing the row directly.
      await expect(
        handle.db.execute(sql`INSERT INTO contact_resolutions (id, lead_id, resolution_type, recipient_email, enrichment_result_id, intended_decision_makers)
           VALUES ('x', ${leadId}, 'PERSONAL_VERIFIED', 'a@b.com', NULL, '[{"fullName":"Richard","title":"Owner","priority":1}]'::jsonb)`),
      ).rejects.toThrow();
      expect(await repo.getCurrent(leadId)).toBeNull();
    });

    it('rejects a GENERIC_OFFICIAL row with no source fact / no source url (contact_resolutions_provenance_ck)', async () => {
      const leadId = await seedLead();
      await expect(
        handle.db.execute(sql`INSERT INTO contact_resolutions (id, lead_id, resolution_type, recipient_email)
           VALUES ('y', ${leadId}, 'GENERIC_OFFICIAL', 'info@completedentistry.co.uk')`),
      ).rejects.toThrow();
    });

    it('rejects UNRESOLVED as a stored value (contact_resolutions_type_ck): it is the absence of a row', async () => {
      const leadId = await seedLead();
      await expect(
        handle.db.execute(sql`INSERT INTO contact_resolutions (id, lead_id, resolution_type, recipient_email)
           VALUES ('z', ${leadId}, 'UNRESOLVED', 'info@completedentistry.co.uk')`),
      ).rejects.toThrow();
    });

    it('keeps at most one current resolution per lead, superseding the previous one', async () => {
      const leadId = await seedLead();
      await seedWebsiteContactEmail(leadId, 'info@completedentistry.co.uk');
      const fact = await new LeadFactsRepository(handle.db).getCurrentFact(leadId, 'contact_email');
      const repo = new ContactResolutionRepository(handle.db);
      await repo.writeCurrentResolution({
        leadId, resolutionType: 'GENERIC_OFFICIAL', recipientEmail: 'info@completedentistry.co.uk',
        sourceFactId: fact?.id, sourceUrl: `https://${DOMAIN}/contact`, intendedDecisionMakers: [],
      });
      await repo.writeCurrentResolution({
        leadId, resolutionType: 'GENERIC_OFFICIAL', recipientEmail: 'reception@completedentistry.co.uk',
        sourceFactId: fact?.id, sourceUrl: `https://${DOMAIN}/contact`, intendedDecisionMakers: [],
      });
      expect((await repo.getCurrent(leadId))?.recipientEmail).toBe('reception@completedentistry.co.uk');
      expect(await repo.listByLead(leadId)).toHaveLength(2);
    });
  });
});
