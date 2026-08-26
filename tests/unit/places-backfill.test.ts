import { describe, expect, it } from 'vitest';
import {
  computeMissingBackfillFacts,
  isExcludedOutreachStatus,
  isTerminalStatus,
  selectBackfillTargets,
} from '../../src/domain/lead-facts/backfill-selection.js';
import { type Lead } from '../../src/domain/leads/lead.js';
import { type LeadStatus } from '../../src/domain/leads/status.js';
import { buildBackfillFacts } from '../../src/persistence/google-place-details-store.js';

function lead(over: Partial<Lead> = {}): Lead {
  return {
    id: 'lead-1', businessName: 'Example Dental', normalizedName: null, domain: null, normalizedDomain: null,
    phone: null, normalizedPhone: null, formattedAddress: null, normalizedAddress: null, latitude: null,
    longitude: null, placeId: 'place-1', city: null, country: null, status: 'QUALIFIED' as LeadStatus,
    priority: null, source: 'google_places', dedupStatus: 'UNIQUE', duplicateOf: null,
    createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'), ...over,
  };
}

/** All leads passed carry enrichment evidence unless a test overrides the set. */
const enrichedAll = (leads: readonly Lead[]): Set<string> => new Set(leads.map((l) => l.id));

describe('places-backfill selection', () => {
  it('skips leads without a placeId', () => {
    const leads = [lead({ id: 'a', placeId: null })];
    const res = selectBackfillTargets(leads, { enrichedLeadIds: enrichedAll(leads) });
    expect(res.selected).toHaveLength(0);
    expect(res.skipped).toEqual([{ leadId: 'a', reason: 'no_place_id' }]);
  });

  it('skips leads with no enrichment evidence (e.g. NEW) without an allowlist', () => {
    const leads = [lead({ id: 'new', status: 'NEW' }), lead({ id: 'q', status: 'QUALIFIED' })];
    // Only the QUALIFIED lead has evidence.
    const res = selectBackfillTargets(leads, { enrichedLeadIds: new Set(['q']) });
    expect(res.selected.map((l) => l.id)).toEqual(['q']);
    expect(res.skipped).toEqual([{ leadId: 'new', reason: 'not_enriched' }]);
  });

  it('excludes outreach-active statuses even when enriched', () => {
    const leads = [lead({ id: 'sched', status: 'SCHEDULED' }), lead({ id: 'fin', status: 'FINALIZED_EMAIL_PENDING' })];
    const res = selectBackfillTargets(leads, { enrichedLeadIds: enrichedAll(leads) });
    expect(res.selected).toHaveLength(0);
    expect(res.skipped.map((s) => s.reason)).toEqual(['excluded_outreach_status', 'excluded_outreach_status']);
  });

  it('excludes terminal/dead statuses even when enriched', () => {
    const leads = [
      lead({ id: 'rej', status: 'REJECTED' }),
      lead({ id: 'auto', status: 'REJECTED_AUTOMATICALLY' }),
      lead({ id: 'dup', status: 'DUPLICATE' }),
    ];
    const res = selectBackfillTargets(leads, { enrichedLeadIds: enrichedAll(leads) });
    expect(res.selected).toHaveLength(0);
    expect(res.skipped.map((s) => s.reason)).toEqual(['terminal_status', 'terminal_status', 'terminal_status']);
  });

  it('includes enriched leads that have advanced past enrichment', () => {
    const leads = [
      lead({ id: 'mr', status: 'NEEDS_MANUAL_REVIEW' }),
      lead({ id: 'audit', status: 'READY_FOR_AUDIT' }),
      lead({ id: 're', status: 'READY_FOR_ENRICHMENT' }),
    ];
    const res = selectBackfillTargets(leads, { enrichedLeadIds: enrichedAll(leads) });
    expect(res.selected.map((l) => l.id).sort()).toEqual(['audit', 'mr', 're']);
  });

  it('respects --limit with deterministic createdAt,id ordering', () => {
    const leads = [
      lead({ id: 'c', createdAt: new Date('2026-01-03T00:00:00Z') }),
      lead({ id: 'a', createdAt: new Date('2026-01-01T00:00:00Z') }),
      lead({ id: 'b', createdAt: new Date('2026-01-02T00:00:00Z') }),
    ];
    const res = selectBackfillTargets(leads, { enrichedLeadIds: enrichedAll(leads), limit: 2 });
    expect(res.selected.map((l) => l.id)).toEqual(['a', 'b']);
  });

  it('single-lead mode obeys the same rules and fails closed', () => {
    const q = lead({ id: 'x', status: 'QUALIFIED' });
    expect(selectBackfillTargets([], { lead: 'x', enrichedLeadIds: new Set() }).skipped)
      .toEqual([{ leadId: 'x', reason: 'lead_not_found' }]);
    expect(selectBackfillTargets([lead({ id: 'x', placeId: null })], { lead: 'x', enrichedLeadIds: new Set(['x']) }).skipped)
      .toEqual([{ leadId: 'x', reason: 'no_place_id' }]);
    // has placeId but no enrichment evidence → fail closed
    expect(selectBackfillTargets([q], { lead: 'x', enrichedLeadIds: new Set() }).skipped)
      .toEqual([{ leadId: 'x', reason: 'not_enriched' }]);
    expect(selectBackfillTargets([lead({ id: 'x', status: 'REJECTED' })], { lead: 'x', enrichedLeadIds: new Set(['x']) }).skipped)
      .toEqual([{ leadId: 'x', reason: 'terminal_status' }]);
    // fully eligible
    expect(selectBackfillTargets([q], { lead: 'x', enrichedLeadIds: new Set(['x']) }).selected.map((l) => l.id))
      .toEqual(['x']);
  });

  it('classifies excluded outreach and terminal statuses', () => {
    expect(isExcludedOutreachStatus('SCHEDULED')).toBe(true);
    expect(isExcludedOutreachStatus('FINALIZED_EMAIL_PENDING')).toBe(true);
    expect(isExcludedOutreachStatus('QUALIFIED')).toBe(false);
    expect(isTerminalStatus('REJECTED')).toBe(true);
    expect(isTerminalStatus('REJECTED_AUTOMATICALLY')).toBe(true);
    expect(isTerminalStatus('DUPLICATE')).toBe(true);
    expect(isTerminalStatus('NEEDS_MANUAL_REVIEW')).toBe(false);
  });
});

describe('places-backfill missing-fact computation', () => {
  it('returns only the backfill types that are absent', () => {
    expect(computeMissingBackfillFacts(new Set())).toEqual(['rating', 'review_count', 'phone']);
    expect(computeMissingBackfillFacts(new Set(['rating']))).toEqual(['review_count', 'phone']);
    expect(computeMissingBackfillFacts(new Set(['rating', 'review_count', 'phone', 'business_name']))).toEqual([]);
  });
});

describe('buildBackfillFacts — construction-enforced scope', () => {
  it('emits ONLY rating/review_count/phone and ignores every other Place Details field', () => {
    const facts = buildBackfillFacts(
      'lead-1',
      'place-1',
      {
        // Non-backfill fields present with values — must be ignored entirely.
        displayName: 'DIFFERENT NAME', formattedAddress: 'DIFFERENT ADDRESS', websiteUri: 'https://different.example',
        primaryType: 'different_type', businessStatus: 'CLOSED_TEMPORARILY',
        // Backfill fields:
        rating: 4.7, userRatingCount: 512, nationalPhoneNumber: '+44 20 7946 0000',
      },
      new Date('2026-07-21T10:00:00Z'),
    );
    expect(facts.map((f) => f.factType).sort()).toEqual(['phone', 'rating', 'review_count']);
    expect(facts.every((f) => f.sourceType === 'google_places')).toBe(true);
  });

  it('omits absent backfill values', () => {
    const facts = buildBackfillFacts('lead-1', 'place-1', { rating: null, userRatingCount: null, nationalPhoneNumber: null }, new Date());
    expect(facts).toHaveLength(0);
  });
});
