import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { requireIntegrationTestDatabase } from '../support/test-database.js';
import { placesBackfillCommand } from '../../src/cli/commands/places-backfill.js';
import { type CliContext } from '../../src/cli/context.js';
import { buildCandidateLead } from '../../src/domain/leads/lead-factory.js';
import { type PlaceDetails, type PlacesDetailsClient } from '../../src/integrations/enrichment/google-places-details.js';
import { type DbHandle } from '../../src/persistence/db.js';
import { EnrichmentRepository } from '../../src/persistence/repositories/enrichment.repo.js';
import { LeadFactsRepository } from '../../src/persistence/repositories/lead-facts.repo.js';
import { LeadsRepository } from '../../src/persistence/repositories/leads.repo.js';
import { PipelineRunsRepository } from '../../src/persistence/repositories/runs.repo.js';
import { type LeadStatus } from '../../src/domain/leads/status.js';

const testDatabase = requireIntegrationTestDatabase();
const logger = pino({ level: 'silent' });

// A live-config stub exposing only the fields places-backfill reads. Cast narrowly per call.
const liveConfig = {
  ALLOW_PAID_READS: true,
  GOOGLE_PLACES_API_KEY: 'test-key',
  ENRICH_HTTP_TIMEOUT_MS: 10_000,
  MAX_GOOGLE_CONTEXT_REQUESTS_PER_RUN: 50,
  MAX_GOOGLE_CONTEXT_COST_USD_PER_RUN: 5,
};

/** Mock Google response whose NON-backfill fields differ from what is already stored. */
const mockClient = (details: PlaceDetails): PlacesDetailsClient => ({ details: async () => details });

describe('places-backfill (PostgreSQL)', () => {
  let handle: DbHandle;

  beforeEach(async () => {
    handle ??= testDatabase.createHandle();
    await testDatabase.truncate(handle.db);
  });
  afterAll(async () => {
    if (handle) await handle.pool.end();
  });

  function ctx(): CliContext {
    return {
      config: liveConfig as unknown as CliContext['config'],
      logger,
      db: handle.db,
      leads: new LeadsRepository(handle.db),
      events: undefined as unknown as CliContext['events'],
      service: undefined as unknown as CliContext['service'],
    };
  }

  async function seedEnrichedLead(): Promise<string> {
    const placeId = `place-${randomUUID()}`;
    const lead = buildCandidateLead({ sourcePlaceId: placeId, source: 'mock' });
    await new LeadsRepository(handle.db).create(lead);
    await new LeadsRepository(handle.db).updateStatus(lead.id, 'QUALIFIED', new Date());
    const facts = new LeadFactsRepository(handle.db);
    const g = (factType: string, value: string, normalized: string) =>
      facts.writeCurrentFact({ leadId: lead.id, factType: factType as never, value, normalizedValue: normalized, sourceType: 'google_places', sourceUrl: null });
    await g('google_place_id', placeId, placeId);
    await g('business_name', 'Original Dental', 'original dental');
    await g('formatted_address', '1 Original Street', '1 original street');
    await g('candidate_website_url', 'https://original.example/', 'https://original.example/');
    await g('category', 'dentist', 'dentist');
    return lead.id;
  }

  /** A lead with a placeId but NO enrichment evidence (no attempt, no google_places facts). */
  async function seedBareLead(status: LeadStatus): Promise<string> {
    const placeId = `place-${randomUUID()}`;
    const lead = buildCandidateLead({ sourcePlaceId: placeId, source: 'mock' });
    await new LeadsRepository(handle.db).create(lead);
    await new LeadsRepository(handle.db).updateStatus(lead.id, status, new Date());
    return lead.id;
  }

  /** A lead whose ONLY enrichment evidence is an enrichment_attempts row (no google_places facts). */
  async function seedAttemptOnlyLead(status: LeadStatus): Promise<string> {
    const leadId = await seedBareLead(status);
    const runId = await new PipelineRunsRepository(handle.db).start('enrich:test', true);
    await new EnrichmentRepository(handle.db).recordAttempt({
      leadId, runId, outcome: 'TRANSIENT_ERROR', chosenDomain: null, chosenWebsiteUrl: null,
      chosenLocationPageUrl: null, confidence: null, candidateCount: 0, contextProvider: 'google',
      candidateProvider: 'mock', notes: null, startedAt: new Date(), completedAt: new Date(),
    });
    return leadId;
  }

  const differentDetails: PlaceDetails = {
    displayName: 'RENAMED CLINIC', formattedAddress: '999 New Road', websiteUri: 'https://renamed.example/',
    primaryType: 'orthodontist', businessStatus: 'CLOSED_TEMPORARILY',
    rating: 4.8, userRatingCount: 640, nationalPhoneNumber: '+44 20 7946 1234',
  };

  it('backfills rating/review_count/phone and leaves all other facts and lead state untouched, even when Google returns different values', async () => {
    const leadId = await seedEnrichedLead();
    await placesBackfillCommand(ctx(), { confirm: true }, { detailsClient: mockClient(differentDetails) });

    const facts = new LeadFactsRepository(handle.db);
    // New backfill facts written.
    expect((await facts.getCurrentFact(leadId, 'rating'))?.value).toBe('4.8');
    expect((await facts.getCurrentFact(leadId, 'review_count'))?.value).toBe('640');
    expect((await facts.getCurrentFact(leadId, 'phone'))?.value).toBe('+44 20 7946 1234');
    // Pre-existing NON-backfill facts unchanged despite different Google values.
    expect((await facts.getCurrentFact(leadId, 'business_name'))?.value).toBe('Original Dental');
    expect((await facts.getCurrentFact(leadId, 'formatted_address'))?.value).toBe('1 Original Street');
    expect((await facts.getCurrentFact(leadId, 'candidate_website_url'))?.value).toBe('https://original.example/');
    expect((await facts.getCurrentFact(leadId, 'category'))?.value).toBe('dentist');
    // Lead state unchanged.
    expect((await new LeadsRepository(handle.db).getById(leadId))?.status).toBe('QUALIFIED');
  });

  it('is idempotent: a second run writes nothing', async () => {
    const leadId = await seedEnrichedLead();
    await placesBackfillCommand(ctx(), { confirm: true }, { detailsClient: mockClient(differentDetails) });
    const before = await new LeadFactsRepository(handle.db).listCurrentFacts(leadId);
    await placesBackfillCommand(ctx(), { confirm: true }, { detailsClient: mockClient(differentDetails) });
    const after = await new LeadFactsRepository(handle.db).listCurrentFacts(leadId);
    expect(after.map((f) => `${f.factType}=${f.value}`).sort()).toEqual(before.map((f) => `${f.factType}=${f.value}`).sort());
    expect(after.filter((f) => f.factType === 'rating')).toHaveLength(1);
  });

  it('never overwrites a manually set phone', async () => {
    const leadId = await seedEnrichedLead();
    await new LeadFactsRepository(handle.db).writeCurrentFact({
      leadId, factType: 'phone', value: '+44 20 0000 0000', normalizedValue: '442000000000', sourceType: 'manual', sourceUrl: null,
    });
    await placesBackfillCommand(ctx(), { confirm: true }, { detailsClient: mockClient(differentDetails) });
    const phone = await new LeadFactsRepository(handle.db).getCurrentFact(leadId, 'phone');
    expect(phone).toMatchObject({ value: '+44 20 0000 0000', sourceType: 'manual' });
  });

  it('PLAN mode makes no API call and writes nothing', async () => {
    const leadId = await seedEnrichedLead();
    let called = 0;
    const spyClient: PlacesDetailsClient = { details: async () => { called += 1; return differentDetails; } };
    await placesBackfillCommand(ctx(), { plan: true }, { detailsClient: spyClient });
    expect(called).toBe(0);
    expect(await new LeadFactsRepository(handle.db).getCurrentFact(leadId, 'rating')).toBeNull();
  });

  it('excludes an outreach-active lead from the default batch', async () => {
    const leadId = await seedEnrichedLead();
    await new LeadsRepository(handle.db).updateStatus(leadId, 'SCHEDULED', new Date());
    let called = 0;
    const spyClient: PlacesDetailsClient = { details: async () => { called += 1; return differentDetails; } };
    await placesBackfillCommand(ctx(), { confirm: true }, { detailsClient: spyClient });
    expect(called).toBe(0);
    expect(await new LeadFactsRepository(handle.db).getCurrentFact(leadId, 'rating')).toBeNull();
  });

  it('excludes a NEW lead with no enrichment evidence (placeId only)', async () => {
    const leadId = await seedBareLead('NEW');
    let called = 0;
    const spyClient: PlacesDetailsClient = { details: async () => { called += 1; return differentDetails; } };
    await placesBackfillCommand(ctx(), { confirm: true }, { detailsClient: spyClient });
    expect(called).toBe(0);
    expect(await new LeadFactsRepository(handle.db).getCurrentFact(leadId, 'rating')).toBeNull();
  });

  it('excludes a REJECTED lead even when it has enrichment evidence', async () => {
    const leadId = await seedEnrichedLead(); // has google_places identity facts
    await new LeadsRepository(handle.db).updateStatus(leadId, 'REJECTED', new Date());
    let called = 0;
    const spyClient: PlacesDetailsClient = { details: async () => { called += 1; return differentDetails; } };
    await placesBackfillCommand(ctx(), { confirm: true }, { detailsClient: spyClient });
    expect(called).toBe(0);
    expect(await new LeadFactsRepository(handle.db).getCurrentFact(leadId, 'rating')).toBeNull();
  });

  it('includes a lead whose only evidence is an enrichment_attempts row (OR-branch)', async () => {
    const leadId = await seedAttemptOnlyLead('READY_FOR_ENRICHMENT');
    await placesBackfillCommand(ctx(), { confirm: true }, { detailsClient: mockClient(differentDetails) });
    expect((await new LeadFactsRepository(handle.db).getCurrentFact(leadId, 'rating'))?.value).toBe('4.8');
  });
});
