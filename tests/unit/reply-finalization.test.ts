import { describe, expect, it } from 'vitest';
import {
  computeReplyFinalization,
  validateReplyFinalization,
  type ReplyFinalizationDraft,
} from '../../src/domain/email/reply-finalization.js';
import { sha256Hex } from '../../src/utils/hash.js';

const LEAD = 'lead-1';
const BODY = 'Hi,\n\nYour booking controls lead to a contact page.\n\nBest,\nAdi';

function draft(over: Partial<ReplyFinalizationDraft> = {}): ReplyFinalizationDraft {
  return { id: 'draft-1', leadId: LEAD, status: 'APPROVED', humanDecision: 'APPROVED', ctaKind: 'reply', body: BODY, ...over };
}

describe('validateReplyFinalization', () => {
  it('accepts an approved reply draft on a HUMAN_APPROVED lead (authorship-agnostic)', () => {
    const r = validateReplyFinalization({ requestedLeadId: LEAD, leadStatus: 'HUMAN_APPROVED', draft: draft() });
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('fails when the lead is not HUMAN_APPROVED', () => {
    const r = validateReplyFinalization({ requestedLeadId: LEAD, leadStatus: 'READY_FOR_HUMAN_APPROVAL', draft: draft() });
    expect(r.ok).toBe(false);
    expect(r.violations).toContain('lead_not_human_approved:READY_FOR_HUMAN_APPROVAL');
  });

  it('fails closed when the draft is missing', () => {
    const r = validateReplyFinalization({ requestedLeadId: LEAD, leadStatus: 'HUMAN_APPROVED', draft: null });
    expect(r.ok).toBe(false);
    expect(r.violations).toContain('draft_not_found');
  });

  const cases: Array<[string, ReplyFinalizationDraft, string]> = [
    ['wrong lead', draft({ leadId: 'other' }), 'draft_wrong_lead'],
    ['status not approved', draft({ status: 'DRAFTED' }), 'draft_status_not_approved:DRAFTED'],
    ['human decision not approved', draft({ humanDecision: null }), 'draft_human_decision_not_approved:none'],
    ['cta not reply', draft({ ctaKind: 'demo_link' }), 'draft_cta_not_reply:demo_link'],
    ['contains demo url token', draft({ body: 'See {{DEMO_URL}} here' }), 'body_contains_demo_url'],
    ['unresolved token', draft({ body: 'Hi {{FIRST_NAME}}' }), 'body_has_unresolved_token'],
  ];
  for (const [name, d, expected] of cases) {
    it(`fails on ${name}`, () => {
      const r = validateReplyFinalization({ requestedLeadId: LEAD, leadStatus: 'HUMAN_APPROVED', draft: d });
      expect(r.ok).toBe(false);
      expect(r.violations).toContain(expected);
    });
  }

  it('allows a body that still contains only the {{SENDER_NAME}} token', () => {
    const r = validateReplyFinalization({ requestedLeadId: LEAD, leadStatus: 'HUMAN_APPROVED', draft: draft({ body: 'Hi,\n\nBest,\n{{SENDER_NAME}}' }) });
    expect(r.ok).toBe(true);
  });
});

describe('computeReplyFinalization', () => {
  it('performs no substitution: resolvedBody === body and both hashes equal sha256(body)', () => {
    const r = computeReplyFinalization(BODY);
    expect(r.resolvedBody).toBe(BODY);
    expect(r.originalBodyHash).toBe(sha256Hex(BODY));
    expect(r.resolvedBodyHash).toBe(sha256Hex(BODY));
    expect(r.originalBodyHash).toBe(r.resolvedBodyHash);
  });
});
