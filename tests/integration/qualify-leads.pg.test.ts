import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { QUALIFICATION_RULES } from '../../src/config/qualification-rules.js';
import { buildLeadFactInputs } from '../../src/domain/lead-facts/build-facts.js';
import { buildCandidateLead, buildLeadFromFacts, type LeadFactsInput } from '../../src/domain/leads/lead-factory.js';
import { LeadService } from '../../src/domain/leads/lead-service.js';
import {
  QualificationService,
  type QualificationTxRepos,
  type QualificationUnitOfWork,
} from '../../src/domain/qualification/qualification-service.js';
import { type QualificationNiche } from '../../src/domain/qualification/qualify.js';
import { createDb, type DbHandle } from '../../src/persistence/db.js';
import { truncateAll } from '../../src/persistence/maintenance.js';
import { DrizzleQualificationUnitOfWork } from '../../src/persistence/qualification-unit-of-work.js';
import { LeadFactsRepository } from '../../src/persistence/repositories/lead-facts.repo.js';
import { LeadsRepository } from '../../src/persistence/repositories/leads.repo.js';
import { PipelineRepository } from '../../src/persistence/repositories/pipeline.repo.js';
import { QualificationResultsRepository } from '../../src/persistence/repositories/qualification.repo.js';
import { SuppressionRepository } from '../../src/persistence/repositories/suppression.repo.js';
import { SuppressionAdminService } from '../../src/domain/suppression/admin-service.js';
import { pipelineEvents, qualificationResultFacts } from '../../src/persistence/schema.js';

const DATABASE_URL = process.env.DATABASE_URL;
const NICHE: QualificationNiche = {
  allowedCategories: ['dentist', 'orthodontist'],
  excludeChains: true,
  chainNames: [],
};

const STRONG: LeadFactsInput = {
  businessName: 'Bright Smile Dental',
  domain: 'brightsmile.example',
  officialDomain: 'https://brightsmile.example',
  phone: '0161 496 0001',
  city: 'Manchester',
  country: 'GB',
  formattedAddress: '12 Oxford Road, Manchester',
  latitude: 53.4739,
  longitude: -2.2352,
  category: 'dentist',
  rating: 4.7,
  reviewCount: 130,
  businessStatus: 'OPERATIONAL',
  ownershipType: 'INDEPENDENT',
};

describe.skipIf(!DATABASE_URL)('qualifyLead (PostgreSQL)', () => {
  let handle: DbHandle;

  beforeEach(async () => {
    handle ??= createDb(DATABASE_URL as string);
    await truncateAll(handle.db);
  });

  afterAll(async () => {
    if (handle) await handle.pool.end();
  });

  function service(): { svc: QualificationService; results: QualificationResultsRepository; leads: LeadsRepository } {
    const svc = new QualificationService(new DrizzleQualificationUnitOfWork(handle.db));
    return {
      svc,
      results: new QualificationResultsRepository(handle.db),
      leads: new LeadsRepository(handle.db),
    };
  }

  async function seedWithFacts(facts: LeadFactsInput): Promise<string> {
    const leads = new LeadsRepository(handle.db);
    const factsRepo = new LeadFactsRepository(handle.db);
    const lead = buildLeadFromFacts(facts, { source: 'mock' });
    await leads.create(lead);
    for (const f of buildLeadFactInputs(lead.id, facts, 'mock', null)) {
      await factsRepo.writeCurrentFact(f);
    }
    return lead.id;
  }

  it('ACCEPT + official domain transitions the lead to QUALIFIED', async () => {
    const id = await seedWithFacts(STRONG);
    const { svc, leads } = service();
    const r = await svc.qualify(id, 'c', NICHE, QUALIFICATION_RULES);
    expect(r.decision).toBe('ACCEPT');
    expect(r.nextStep).toBe('AUDIT');
    expect((await leads.getById(id))?.status).toBe('QUALIFIED');
  });

  it('Place-ID-only candidate routes to READY_FOR_ENRICHMENT', async () => {
    const leads = new LeadsRepository(handle.db);
    const candidate = buildCandidateLead({ sourcePlaceId: 'place-xyz', source: 'google_places' });
    await leads.create(candidate);
    const { svc } = service();
    const r = await svc.qualify(candidate.id, 'c', NICHE, QUALIFICATION_RULES);
    expect(r.nextStep).toBe('NEEDS_ENRICHMENT');
    expect((await leads.getById(candidate.id))?.status).toBe('READY_FOR_ENRICHMENT');
  });

  it('appends a new result on repeated qualification (never overwrites)', async () => {
    // Weak lead → REVIEW → NEEDS_MANUAL_REVIEW, which stays re-qualifiable.
    const id = await seedWithFacts({
      ...STRONG,
      officialDomain: null,
      rating: 3.0,
      reviewCount: 3,
      ownershipType: 'UNKNOWN',
    });
    const { svc, results } = service();
    const first = await svc.qualify(id, 'c', NICHE, QUALIFICATION_RULES);
    const second = await svc.qualify(id, 'c', NICHE, QUALIFICATION_RULES);
    expect(await results.countByLead(id)).toBe(2);
    expect(first.inputFingerprint).toBe(second.inputFingerprint); // stable across identical inputs
  });

  it('suppression gate rejects and transitions to REJECTED', async () => {
    const id = await seedWithFacts(STRONG);
    const supp = new SuppressionRepository(handle.db);
    await supp.add('domain', 'brightsmile.example', 'test');
    const { svc, leads } = service();
    const r = await svc.qualify(id, 'c', NICHE, QUALIFICATION_RULES);
    expect(r.decision).toBe('REJECT');
    expect(r.triggeredRules).toContain('gate.suppressed');
    expect((await leads.getById(id))?.status).toBe('REJECTED');
  });

  it('audits suppression add/revoke and excludes revoked identities from active matching', async () => {
    const repo = new SuppressionRepository(handle.db); const events = new PipelineRepository(handle.db);
    const admin = new SuppressionAdminService(repo, events, () => new Date('2026-07-21T00:00:00Z'));
    const id = await admin.add('domain', 'example.invalid', 'fictional objection', 'Example Operator');
    expect(await repo.isSuppressed({ normalizedDomain: 'example.invalid', normalizedPhone: null, placeId: null })).toBe(true);
    const viewed = await admin.list('domain'); expect(viewed).toHaveLength(1); expect(viewed[0]?.valueHash).not.toContain('example.invalid');
    expect(await admin.revoke(id, 'fictional resolution', 'Example Operator')).toBe(true);
    expect(await repo.isSuppressed({ normalizedDomain: 'example.invalid', normalizedPhone: null, placeId: null })).toBe(false);
    const audit = await handle.db.select().from(pipelineEvents);
    expect(audit.filter((e) => e.message?.startsWith('suppression:')).map((e) => e.message)).toEqual(['suppression: ADDED', 'suppression: REVOKED']);
    expect(JSON.stringify(audit)).not.toContain('example.invalid');
  });

  it('enforces one current fact per (lead, type) via the partial unique index', async () => {
    const id = await seedWithFacts(STRONG);
    // A second raw insert of a CURRENT business_name (without superseding) must fail.
    await expect(
      handle.db.execute(
        sql`INSERT INTO lead_facts (id, lead_id, fact_type, value, source_type, is_current)
            VALUES ('dup-current', ${id}, 'business_name', 'Dup', 'mock', true)`,
      ),
    ).rejects.toBeTruthy();
  });

  it('serializes competing current-fact updates (exactly one current survives)', async () => {
    const id = await seedWithFacts(STRONG);
    const write = (val: string): Promise<void> =>
      handle.db.transaction(async (tx) => {
        await new LeadFactsRepository(tx).writeCurrentFact({
          leadId: id,
          factType: 'business_name',
          value: val,
          normalizedValue: val.toLowerCase(),
          sourceType: 'manual',
          sourceUrl: null,
        });
      });

    // Two transactions race to replace the current business_name fact.
    await Promise.allSettled([write('Name A'), write('Name B')]);

    // Whatever the interleaving, the partial unique index guarantees the invariant:
    // exactly one current business_name fact remains.
    const current = (await new LeadFactsRepository(handle.db).listCurrentFacts(id)).filter(
      (f) => f.factType === 'business_name',
    );
    expect(current).toHaveLength(1);
  });

  it('rolls back the ENTIRE qualification write when the state transition fails', async () => {
    const id = await seedWithFacts(STRONG);
    // Pre-advance so the ONLY transition during qualify is the final state change.
    const ls = new LeadService(new LeadsRepository(handle.db), new PipelineRepository(handle.db));
    await ls.transition(id, 'NORMALIZED');
    await ls.transition(id, 'READY_FOR_QUALIFICATION');

    const eventsBefore = (
      await handle.db.select().from(pipelineEvents).where(eq(pipelineEvents.leadId, id))
    ).length;

    // A unit of work whose leadService.transition throws AFTER results.save has run.
    const failingUow: QualificationUnitOfWork = {
      transaction: (fn) =>
        handle.db.transaction(async (tx) => {
          const leads = new LeadsRepository(tx);
          const leadService = {
            transition: async (): Promise<never> => {
              throw new Error('injected failure after result insert, before state transition');
            },
          } as unknown as LeadService;
          const repos: QualificationTxRepos = {
            leads,
            leadService,
            facts: new LeadFactsRepository(tx),
            results: new QualificationResultsRepository(tx),
            suppression: new SuppressionRepository(tx),
          };
          return fn(repos);
        }),
    };

    const svc = new QualificationService(failingUow);
    await expect(svc.qualify(id, 'c', NICHE, QUALIFICATION_RULES)).rejects.toThrow(/injected failure/);

    // No partial write survived: no result, no fact links, no state change, no new event.
    const results = new QualificationResultsRepository(handle.db);
    expect(await results.countByLead(id)).toBe(0);
    expect(await handle.db.select().from(qualificationResultFacts)).toHaveLength(0);
    expect((await new LeadsRepository(handle.db).getById(id))?.status).toBe('READY_FOR_QUALIFICATION');
    const eventsAfter = (
      await handle.db.select().from(pipelineEvents).where(eq(pipelineEvents.leadId, id))
    ).length;
    expect(eventsAfter).toBe(eventsBefore);
  });
});
