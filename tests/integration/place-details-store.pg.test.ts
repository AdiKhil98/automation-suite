import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { requireIntegrationTestDatabase } from '../support/test-database.js';
import { buildCandidateLead } from '../../src/domain/leads/lead-factory.js';
import { type DbHandle } from '../../src/persistence/db.js';
import { DrizzleGooglePlaceDetailsStore } from '../../src/persistence/google-place-details-store.js';
import { type PlaceDetails } from '../../src/integrations/enrichment/google-places-details.js';
import { LeadFactsRepository } from '../../src/persistence/repositories/lead-facts.repo.js';
import { LeadsRepository } from '../../src/persistence/repositories/leads.repo.js';

const testDatabase = requireIntegrationTestDatabase();

/**
 * Store-level invariants for the enrichment signal-completion change: rating, review_count and
 * phone persist with google_places provenance, re-persistence is idempotent, and a manually set
 * fact is never overwritten by a google_places value.
 */
describe('DrizzleGooglePlaceDetailsStore — rating/review_count/phone (PostgreSQL)', () => {
  let handle: DbHandle;

  beforeEach(async () => {
    handle ??= testDatabase.createHandle();
    await testDatabase.truncate(handle.db);
  });
  afterAll(async () => {
    if (handle) await handle.pool.end();
  });

  async function seedLead(): Promise<{ leadId: string; placeId: string }> {
    const placeId = `place-${randomUUID()}`;
    const lead = buildCandidateLead({ sourcePlaceId: placeId, source: 'mock' });
    await new LeadsRepository(handle.db).create(lead);
    return { leadId: lead.id, placeId };
  }

  const details = (over: Partial<PlaceDetails> = {}): PlaceDetails => ({
    displayName: 'Example Dental',
    rating: 4.6,
    userRatingCount: 231,
    nationalPhoneNumber: '+44 20 7946 0000',
    ...over,
  });

  it('persists rating, review_count and phone with google_places provenance', async () => {
    const { leadId, placeId } = await seedLead();
    const store = new DrizzleGooglePlaceDetailsStore(handle.db);
    await store.persist({ leadId, placeId, provider: 'google_places', retrievedAt: new Date(), details: details(), persistApprovedPhone: true });

    const repo = new LeadFactsRepository(handle.db);
    const rating = await repo.getCurrentFact(leadId, 'rating');
    const reviews = await repo.getCurrentFact(leadId, 'review_count');
    const phone = await repo.getCurrentFact(leadId, 'phone');
    expect(rating).toMatchObject({ value: '4.6', sourceType: 'google_places', isCurrent: true });
    expect(reviews).toMatchObject({ value: '231', sourceType: 'google_places', isCurrent: true });
    expect(phone).toMatchObject({ value: '+44 20 7946 0000', sourceType: 'google_places', isCurrent: true });
  });

  it('is idempotent: re-persisting unchanged values writes nothing and keeps one current fact per type', async () => {
    const { leadId, placeId } = await seedLead();
    const store = new DrizzleGooglePlaceDetailsStore(handle.db);
    const first = await store.persist({ leadId, placeId, provider: 'google_places', retrievedAt: new Date(), details: details(), persistApprovedPhone: true });
    const second = await store.persist({ leadId, placeId, provider: 'google_places', retrievedAt: new Date(), details: details(), persistApprovedPhone: true });

    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0);
    const all = await new LeadFactsRepository(handle.db).listCurrentFacts(leadId);
    expect(all.filter((f) => f.factType === 'rating')).toHaveLength(1);
    expect(all.filter((f) => f.factType === 'review_count')).toHaveLength(1);
    expect(all.filter((f) => f.factType === 'phone')).toHaveLength(1);
  });

  it('supersedes a changed google_places value without duplicating the current fact', async () => {
    const { leadId, placeId } = await seedLead();
    const store = new DrizzleGooglePlaceDetailsStore(handle.db);
    await store.persist({ leadId, placeId, provider: 'google_places', retrievedAt: new Date(), details: details({ userRatingCount: 231 }), persistApprovedPhone: true });
    await store.persist({ leadId, placeId, provider: 'google_places', retrievedAt: new Date(), details: details({ userRatingCount: 240 }), persistApprovedPhone: true });

    const reviews = await new LeadFactsRepository(handle.db).getCurrentFact(leadId, 'review_count');
    expect(reviews?.value).toBe('240');
    const all = await new LeadFactsRepository(handle.db).listCurrentFacts(leadId);
    expect(all.filter((f) => f.factType === 'review_count')).toHaveLength(1);
  });

  it('never overwrites a manually set phone with a google_places value', async () => {
    const { leadId, placeId } = await seedLead();
    await new LeadFactsRepository(handle.db).writeCurrentFact({
      leadId, factType: 'phone', value: '+44 20 0000 0000', normalizedValue: '442000000000', sourceType: 'manual', sourceUrl: null,
    });
    await new DrizzleGooglePlaceDetailsStore(handle.db).persist({
      leadId, placeId, provider: 'google_places', retrievedAt: new Date(), details: details(), persistApprovedPhone: true,
    });

    const phone = await new LeadFactsRepository(handle.db).getCurrentFact(leadId, 'phone');
    expect(phone).toMatchObject({ value: '+44 20 0000 0000', sourceType: 'manual' });
    // Rating/review_count (no manual fact present) still persist normally.
    expect((await new LeadFactsRepository(handle.db).getCurrentFact(leadId, 'rating'))?.value).toBe('4.6');
  });
});
