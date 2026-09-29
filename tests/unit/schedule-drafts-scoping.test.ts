import { describe, expect, it } from 'vitest';
import {
  checkScopedDraft, checkScopedTarget, selectSweepTargets, type ScopedLeadSnapshot,
} from '../../src/cli/commands/schedule-drafts.js';

const TARGET = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002'; // a second, equally eligible DRAFT_CREATED lead
const MISSING = 'cccccccc-0000-4000-8000-000000000003';

const draftCreated = (id: string): ScopedLeadSnapshot => ({ id, status: 'DRAFT_CREATED' });
const createdDraft = { outcome: 'DRAFT_CREATED', providerDraftId: 'draft-xyz' };

/** Both leads are eligible, so any leak from the scoped path would show up as OTHER. */
const population: ScopedLeadSnapshot[] = [draftCreated(TARGET), draftCreated(OTHER)];

describe('schedule-drafts --lead scoping gate', () => {
  it('selects ONLY the named lead while another eligible DRAFT_CREATED lead is untouched', () => {
    const decision = checkScopedTarget(TARGET, population.find((l) => l.id === TARGET) ?? null);

    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error('expected the scoped target to be accepted');
    expect(decision.lead.id).toBe(TARGET);

    // The scoped run considers exactly one lead; the other eligible lead is never included.
    const considered = [decision.lead].map((l) => l.id);
    expect(considered).toEqual([TARGET]);
    expect(considered).not.toContain(OTHER);
    // ...whereas the broad sweep over the same population would have taken both.
    expect(selectSweepTargets(population).map((l) => l.id)).toEqual([TARGET, OTHER]);
  });

  it('fails closed for a nonexistent lead and does not fall back to the sweep', () => {
    const decision = checkScopedTarget(MISSING, null);

    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('expected a nonexistent lead to be refused');
    expect(decision.reason).toBe(`lead_not_found:${MISSING}`);
    expect(decision).not.toHaveProperty('lead');
  });

  it.each(['SCHEDULED', 'HUMAN_APPROVED', 'NEEDS_MANUAL_REVIEW', 'SENT_CONFIRMED', 'QUALIFIED'])(
    'fails closed for a lead in %s (not DRAFT_CREATED)',
    (status) => {
      const decision = checkScopedTarget(TARGET, { id: TARGET, status });

      expect(decision.ok).toBe(false);
      if (decision.ok) throw new Error(`expected ${status} to be refused`);
      expect(decision.reason).toBe(`lead_not_draft_created:${status}`);
    },
  );

  it('accepts a lead whose Gmail draft was created with a provider id', () => {
    expect(checkScopedDraft(createdDraft)).toEqual({ ok: true });
  });

  it.each([
    ['no Gmail draft at all', null, 'no_gmail_draft'],
    ['a draft that was not created', { outcome: 'FAILED', providerDraftId: 'd1' }, 'gmail_draft_not_created:FAILED'],
    ['a created draft missing its provider id', { outcome: 'DRAFT_CREATED', providerDraftId: null }, 'no_provider_draft_id'],
  ])('fails closed on %s', (_label, gmailDraft, reason) => {
    expect(checkScopedDraft(gmailDraft)).toEqual({ ok: false, reason });
  });
});

describe('schedule-drafts broad sweep (unscoped behavior is unchanged)', () => {
  const mixed: ScopedLeadSnapshot[] = [
    draftCreated(TARGET),
    { id: OTHER, status: 'SCHEDULED' },
    draftCreated(MISSING),
    { id: 'dddddddd-0000-4000-8000-000000000004', status: 'QUALIFIED' },
  ];

  it('keeps every DRAFT_CREATED lead, in listing order, when no limit is given', () => {
    expect(selectSweepTargets(mixed).map((l) => l.id)).toEqual([TARGET, MISSING]);
  });

  it('applies --limit as a slice of the eligible leads, exactly as before', () => {
    expect(selectSweepTargets(mixed, '1').map((l) => l.id)).toEqual([TARGET]);
    expect(selectSweepTargets(mixed, '10').map((l) => l.id)).toEqual([TARGET, MISSING]);
  });

  it('returns nothing when no lead is DRAFT_CREATED', () => {
    expect(selectSweepTargets([{ id: OTHER, status: 'SCHEDULED' }])).toEqual([]);
  });
});
