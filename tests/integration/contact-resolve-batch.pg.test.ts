import { randomUUID } from 'node:crypto';
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
import { ContactEnrichmentRepository } from '../../src/persistence/repositories/contact-enrichment.repo.js';
import { type ContactEnrichmentProvider } from '../../src/domain/contact-enrichment/provider.js';
import { type ResolveCascadeProvider } from '../../src/domain/contact-resolve-batch/eligibility.js';
import { type EnrichmentQuery, type PreviewPerson, type ProviderEnrichmentOutcome } from '../../src/domain/contact-enrichment/types.js';

const testDatabase = requireIntegrationTestDatabase();
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;
const DOMAIN = 'diamond-smile.com';

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
  tmpDir = mkdtempSync(join(tmpdir(), 'contact-resolve-batch-test-'));
  const path = join(tmpDir, 'candidates.json');
  writeFileSync(path, JSON.stringify(byLead), 'utf8');
  return path;
}
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

/** Minimal fake ContactEnrichmentProvider. preview() echoes the candidates as PreviewPerson (matching
 * both Hunter's real zero-network echo and Instantly's domain-scoped preview closely enough for local
 * matching to succeed), unless `noMatch` is set. */
function fakeProvider(name: ResolveCascadeProvider, opts: {
  noMatch?: boolean;
  enrichResponder?: (q: EnrichmentQuery) => ProviderEnrichmentOutcome;
  onEnrich?: () => void;
} = {}): ContactEnrichmentProvider {
  return {
    name,
    preview: (domain, candidates = []) => {
      const people: PreviewPerson[] = opts.noMatch
        ? []
        : candidates.map((c) => ({ name: c.fullName, firstName: c.firstName, lastName: c.lastName, domain, title: c.title, providerLeadId: null }));
      return Promise.resolve({ domain, people, creditsReported: null, resourceId: null, endpoint: `fake://${name}/preview`, rawDigest: 'd' });
    },
    estimate: (query) => Promise.resolve({ query, available: true, projectedCredits: 1, endpoint: `fake://${name}/estimate` }),
    enrich: (query) => {
      opts.onEnrich?.();
      if (opts.enrichResponder) return Promise.resolve(opts.enrichResponder(query));
      return Promise.resolve({
        query, email: null, returnedIdentity: null, verificationStatus: 'NOT_FOUND', dataQuality: null, confidence: null,
        creditsReported: null, resourceId: null, endpoint: `fake://${name}/enrich`, rawDigest: 'd', requestsUsed: 1, creditsUsed: 0,
      });
    },
  };
}

const verifiedResponder = (domain: string) => (q: EnrichmentQuery): ProviderEnrichmentOutcome => ({
  query: q, email: `${q.firstName.toLowerCase()}@${domain}`,
  returnedIdentity: { name: q.fullName, firstName: q.firstName, lastName: q.lastName, domain, title: q.title },
  verificationStatus: 'VERIFIED', dataQuality: null, confidence: 0.9, creditsReported: null, resourceId: null,
  endpoint: 'fake://enrich', rawDigest: 'd', requestsUsed: 1, creditsUsed: 1,
});

const genericMailboxResponder = (domain: string) => (q: EnrichmentQuery): ProviderEnrichmentOutcome => ({
  query: q, email: `info@${domain}`,
  returnedIdentity: { name: q.fullName, firstName: q.firstName, lastName: q.lastName, domain, title: q.title },
  verificationStatus: 'VERIFIED', dataQuality: null, confidence: 0.9, creditsReported: null, resourceId: null,
  endpoint: 'fake://enrich', rawDigest: 'd', requestsUsed: 1, creditsUsed: 1,
});

const erroringResponder = (): ProviderEnrichmentOutcome => {
  throw new Error('simulated provider failure');
};

describe('contact-resolve-batch (PostgreSQL)', () => {
  let handle: DbHandle;
  beforeEach(async () => { handle ??= testDatabase.createHandle(); await testDatabase.truncate(handle.db); });
  afterAll(async () => { if (handle) await handle.pool.end(); });

  function ctx(overrides: Partial<typeof liveConfig> = {}): CliContext {
    return {
      config: { ...liveConfig, ...overrides } as unknown as CliContext['config'],
      logger,
      db: handle.db,
      leads: new LeadsRepository(handle.db),
      events: undefined as unknown as CliContext['events'],
      service: undefined as unknown as CliContext['service'],
    };
  }

  async function seedQualifiedLead(businessName = 'Diamond Smile', domain = DOMAIN): Promise<string> {
    const id = randomUUID();
    await handle.db.insert(leads).values({ id, businessName, normalizedDomain: domain, status: 'QUALIFIED' });
    await new LeadFactsRepository(handle.db).writeCurrentFact({
      leadId: id, factType: 'official_domain', value: domain, normalizedValue: domain, sourceType: 'manual', sourceUrl: null,
    });
    return id;
  }

  const CANDS = [{ fullName: 'Shyam Shastri', title: 'Principal Dentist' }, { fullName: 'Shaimil Patel', title: 'Clinical Director' }];

  it('PLAN mode makes zero provider calls', async () => {
    const leadId = await seedQualifiedLead();
    const candidatesFile = writeCandidatesFile({ [leadId]: CANDS });
    let calls = 0;
    await contactResolveBatchCommand(ctx(), { candidatesFile }, { buildProvider: () => { calls += 1; return fakeProvider('instantly'); } });
    expect(calls).toBe(0);
    expect(await new ContactEnrichmentRepository(handle.db).listByLead(leadId)).toHaveLength(0);
  });

  it('cascades from Instantly (no match) to Hunter (verifies), stopping the cascade for that lead', async () => {
    const leadId = await seedQualifiedLead();
    const candidatesFile = writeCandidatesFile({ [leadId]: CANDS });
    let hunterEnrichCalls = 0;
    await contactResolveBatchCommand(ctx(), { candidatesFile, confirm: true }, {
      buildProvider: (name) => name === 'instantly'
        ? fakeProvider('instantly', { noMatch: true })
        : fakeProvider('hunter', { enrichResponder: verifiedResponder(DOMAIN), onEnrich: () => { hunterEnrichCalls += 1; } }),
    });
    const rows = await new ContactEnrichmentRepository(handle.db).listByLead(leadId);
    expect(rows.some((r) => r.provider === 'instantly' && r.outcome === 'PREVIEW_NO_MATCH')).toBe(true);
    expect(rows.some((r) => r.provider === 'hunter' && r.outcome === 'VERIFIED')).toBe(true);
    expect(hunterEnrichCalls).toBe(1); // exactly one candidate needed to reach VERIFIED
  });

  it('run-wide request cap stops the whole run before touching a later lead', async () => {
    const lead1 = await seedQualifiedLead('Lead One');
    const lead2 = await seedQualifiedLead('Lead Two');
    const candidatesFile = writeCandidatesFile({ [lead1]: CANDS, [lead2]: CANDS });
    // Per-lead caps of 1 request mean Instantly alone consumes lead1's ENTIRE run-wide budget (1),
    // so Hunter is never reached for lead1 either, and lead2 is never touched at all.
    await contactResolveBatchCommand(
      ctx({ CONTACT_ENRICHMENT_MAX_REQUESTS_PER_RUN: 1, CONTACT_ENRICHMENT_MAX_CREDITS_PER_RUN: 1 }),
      { candidatesFile, confirm: true, maxTotalRequests: '1' },
      { buildProvider: (name) => fakeProvider(name) },
    );
    const rows1 = await new ContactEnrichmentRepository(handle.db).listByLead(lead1);
    const rows2 = await new ContactEnrichmentRepository(handle.db).listByLead(lead2);
    expect(rows1).toHaveLength(1);
    expect(rows1[0]).toMatchObject({ provider: 'instantly', outcome: 'CAPPED' });
    expect(rows2).toHaveLength(0); // lead2 untouched — run-wide budget stopped the whole run first
  });

  it('--stop-after-first-verified halts the run before a later lead is attempted', async () => {
    const lead1 = await seedQualifiedLead('Lead One');
    const lead2 = await seedQualifiedLead('Lead Two');
    const candidatesFile = writeCandidatesFile({ [lead1]: CANDS, [lead2]: CANDS });
    await contactResolveBatchCommand(ctx(), { candidatesFile, confirm: true, stopAfterFirstVerified: true }, {
      buildProvider: (name) => name === 'instantly' ? fakeProvider('instantly', { enrichResponder: verifiedResponder(DOMAIN) }) : fakeProvider('hunter'),
    });
    expect(await new ContactEnrichmentRepository(handle.db).listByLead(lead1)).not.toHaveLength(0);
    expect(await new ContactEnrichmentRepository(handle.db).listByLead(lead2)).toHaveLength(0);
  });

  it('rejects a generic mailbox even when the provider marks it VERIFIED, and the cascade does not falsely stop', async () => {
    const leadId = await seedQualifiedLead();
    const candidatesFile = writeCandidatesFile({ [leadId]: CANDS });
    await contactResolveBatchCommand(ctx(), { candidatesFile, confirm: true }, {
      buildProvider: (name) => fakeProvider(name, { enrichResponder: genericMailboxResponder(DOMAIN) }),
    });
    const rows = await new ContactEnrichmentRepository(handle.db).listByLead(leadId);
    expect(rows.every((r) => r.outcome !== 'VERIFIED')).toBe(true);
    expect(rows.some((r) => r.provider === 'instantly' && (r.provenance as { attempts?: Array<{ reason?: string }> }).attempts?.some((a) => a.reason === 'generic_mailbox_rejected'))).toBe(true);
  });

  it('a provider ERROR outcome does not block a later lead from being attempted', async () => {
    // buildProvider is called ONCE per provider name for the whole run (the same ContactEnrichmentService
    // instance is reused across every lead), so the two leads are distinguished by domain — the shared
    // responder errors only for lead1's domain, proving a per-lead outcome, not a per-provider-instance one.
    const domain1 = 'lead-one.example';
    const domain2 = 'lead-two.example';
    const lead1 = await seedQualifiedLead('Lead One', domain1);
    const lead2 = await seedQualifiedLead('Lead Two', domain2);
    const candidatesFile = writeCandidatesFile({ [lead1]: CANDS, [lead2]: CANDS });
    const perLeadResponder = (q: EnrichmentQuery): ProviderEnrichmentOutcome => {
      if (q.domain === domain1) return erroringResponder();
      return {
        query: q, email: null, returnedIdentity: null, verificationStatus: 'NOT_FOUND', dataQuality: null, confidence: null,
        creditsReported: null, resourceId: null, endpoint: 'fake://enrich', rawDigest: 'd', requestsUsed: 1, creditsUsed: 0,
      };
    };
    await contactResolveBatchCommand(ctx(), { candidatesFile, confirm: true }, {
      buildProvider: (name) => fakeProvider(name, { enrichResponder: perLeadResponder }),
    });
    const rows1 = await new ContactEnrichmentRepository(handle.db).listByLead(lead1);
    const rows2 = await new ContactEnrichmentRepository(handle.db).listByLead(lead2);
    expect(rows1.some((r) => r.outcome === 'ERROR')).toBe(true);
    expect(rows2.length).toBeGreaterThan(0); // lead2 WAS attempted despite lead1 erroring
    expect(rows2.every((r) => r.outcome !== 'ERROR')).toBe(true);
  });

  it('DRY_RUN=true fails fast before any lead is touched', async () => {
    const leadId = await seedQualifiedLead();
    const candidatesFile = writeCandidatesFile({ [leadId]: CANDS });
    await expect(contactResolveBatchCommand(ctx({ DRY_RUN: true }), { candidatesFile, confirm: true }))
      .rejects.toMatchObject({ code: 'DRY_RUN_LIVE_BLOCKED' });
    expect(await new ContactEnrichmentRepository(handle.db).listByLead(leadId)).toHaveLength(0);
  });

  it('idempotency: a second run makes no additional provider calls once the lead is resolved (NOT_FOUND on all available steps)', async () => {
    const leadId = await seedQualifiedLead();
    const candidatesFile = writeCandidatesFile({ [leadId]: CANDS });
    let calls = 0;
    const buildProvider = (name: ResolveCascadeProvider): ContactEnrichmentProvider => fakeProvider(name, { onEnrich: () => { calls += 1; } });
    await contactResolveBatchCommand(ctx(), { candidatesFile, confirm: true }, { buildProvider });
    const callsAfterFirstRun = calls;
    expect(callsAfterFirstRun).toBeGreaterThan(0);
    await contactResolveBatchCommand(ctx(), { candidatesFile, confirm: true }, { buildProvider });
    expect(calls).toBe(callsAfterFirstRun); // second run: lead is chain_exhausted, not even selected
  });
});
