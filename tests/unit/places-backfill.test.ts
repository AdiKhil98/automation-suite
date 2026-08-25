import { describe, expect, it } from 'vitest';
import {
  computeMissingBackfillFacts,
  isExcludedOutreachStatus,
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

describe('places-backfill selection', () => {
  it('skips leads without a placeId', () => {
    const res = selectBackfillTargets([lead({ id: 'a', placeId: null })], { includeActive: false });
    expect(res.selected).toHaveLength(0);
    expect(res.skipped).toEqual([{ leadId: 'a', reason: 'no_place_id' }]);
  });

  it('excludes outreach-active statuses by default and includes them with includeActive', () => {
    const leads = [lead({ id: 'sched', status: 'SCHEDULED' }), lead({ id: 'fin', status: 'FINALIZED_EMAIL_PENDING' })];
    const off = selectBackfillTargets(leads, { includeActive: false });
    expect(off.selected).toHaveLength(0);
    expect(off.skipped.map((s) => s.reason)).toEqual(['excluded_outreach_status', 'excluded_outreach_status']);

    const on = selectBackfillTargets(leads, { includeActive: true });
    expect(on.selected.map((l) => l.id).sort()).toEqual(['fin', 'sched']);
  });

  it('respects --limit with deterministic createdAt,id ordering', () => {
    const leads = [
      lead({ id: 'c', createdAt: new Date('2026-01-03T00:00:00Z') }),
      lead({ id: 'a', createdAt: new Date('2026-01-01T00:00:00Z') }),
      lead({ id: 'b', createdAt: new Date('2026-01-02T00:00:00Z') }),
    ];
    const res = selectBackfillTargets(leads, { includeActive: false, limit: 2 });
    expect(res.selected.map((l) => l.id)).toEqual(['a', 'b']);
  });

  it('single-lead mode is fail-closed', () => {
    expect(selectBackfillTargets([], { lead: 'x', includeActive: false }).skipped).toEqual([{ leadId: 'x', reason: 'lead_not_found' }]);
    expect(selectBackfillTargets([lead({ id: 'x', placeId: null })], { lead: 'x', includeActive: false }).skipped)
      .toEqual([{ leadId: 'x', reason: 'no_place_id' }]);
    expect(selectBackfillTargets([lead({ id: 'x', status: 'SENT' })], { lead: 'x', includeActive: false }).skipped)
      .toEqual([{ leadId: 'x', reason: 'excluded_outreach_status' }]);
    expect(selectBackfillTargets([lead({ id: 'x', status: 'SENT' })], { lead: 'x', includeActive: true }).selected.map((l) => l.id))
      .toEqual(['x']);
  });

  it('classifies excluded outreach statuses', () => {
    expect(isExcludedOutreachStatus('SCHEDULED')).toBe(true);
    expect(isExcludedOutreachStatus('FINALIZED_EMAIL_PENDING')).toBe(true);
    expect(isExcludedOutreachStatus('QUALIFIED')).toBe(false);
    expect(isExcludedOutreachStatus('NEEDS_MANUAL_REVIEW')).toBe(false);
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
