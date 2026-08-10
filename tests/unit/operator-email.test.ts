import { describe, expect, it } from 'vitest';
import {
  computeOperatorEmailHash,
  OPERATOR_EMAIL_RULES_VERSION,
  validateOperatorEmail,
} from '../../src/domain/email/operator-email.js';
import { checkGmailEligibility, type GmailEligibilitySnapshot } from '../../src/domain/gmail/eligibility.js';

// The exact human-authored Mayfield email (rendered: greeting + body + CTA + signoff).
const MAYFIELD_SUBJECT = 'Mayfield’s appointment booking path';
const MAYFIELD_BODY = `Hi,

I noticed Mayfield Dental’s “Book appointment” buttons lead to an appointment-request form rather than a direct online scheduling flow.

For someone ready to book, that means they still need to submit their details and preferred date rather than choosing an available appointment directly. Adding a direct booking path could make that next step more straightforward.

If useful, I can show you what that could look like on Mayfield’s website.

Best,
Adi`;

describe('validateOperatorEmail — passes clean prospect-only copy', () => {
  it('accepts the exact human-authored Mayfield email', () => {
    const r = validateOperatorEmail({ subject: MAYFIELD_SUBJECT, body: MAYFIELD_BODY, language: 'en' });
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe('validateOperatorEmail — fails on unsupported/prohibited content', () => {
  const base = { subject: 'A note about your booking path', language: 'en' as const };
  const cases: Array<[string, string, string]> = [
    ['contains_url', 'Take a look at https://example.com for details.', 'contains_url'],
    ['contains_metric_claim', 'This could improve results by 20% overall.', 'contains_metric_claim'],
    ['contains_performance_claim', 'A direct path would boost your sales quickly.', 'contains_performance_claim'],
    ['unsupported_competitor_language', 'Your competitors already do this on their sites.', 'unsupported_competitor_language'],
    ['contains_fake_urgency', 'Act now before this opportunity closes.', 'contains_fake_urgency'],
    ['contains_unsupported_customer_behavior', 'Patients are leaving your site every day.', 'contains_unsupported_customer_behavior'],
    ['mentions_demo_without_approved_demo', 'I built a quick demo of the change for you.', 'mentions_demo_without_approved_demo'],
    ['contains_emoji', 'Your booking path could be smoother 🚀 for visitors.', 'contains_emoji'],
    ['contains_em_dash', 'The booking path — as reviewed — routes to a form.', 'contains_em_dash'],
  ];
  for (const [name, body, expected] of cases) {
    it(`flags ${name}`, () => {
      const r = validateOperatorEmail({ ...base, body });
      expect(r.ok).toBe(false);
      expect(r.violations).toContain(expected);
    });
  }

  it('reuses the deterministic-finding denylist (overstated booking claim)', () => {
    const r = validateOperatorEmail({ ...base, body: 'Right now patients cannot book with you at all.' });
    expect(r.ok).toBe(false);
    expect(r.violations).toContain('prohibited_claim:cannot_book');
  });

  it('flags an empty subject and an empty body', () => {
    const r = validateOperatorEmail({ subject: '   ', body: '   ', language: 'en' });
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual(expect.arrayContaining(['empty_subject', 'empty_body']));
  });
});

describe('computeOperatorEmailHash — reproducible', () => {
  const inputA = {
    leadId: 'lead-1', deterministicFindingId: 'find-1', subject: MAYFIELD_SUBJECT, body: MAYFIELD_BODY,
    evidenceIds: ['b', 'a', 'c'], rulesVersion: OPERATOR_EMAIL_RULES_VERSION,
  };
  it('is independent of evidence-id ordering and 64 hex chars', () => {
    const a = computeOperatorEmailHash(inputA);
    const b = computeOperatorEmailHash({ ...inputA, evidenceIds: ['c', 'a', 'b'] });
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });
  it('changes when the exact subject or body changes', () => {
    const base = computeOperatorEmailHash(inputA);
    expect(computeOperatorEmailHash({ ...inputA, subject: `${MAYFIELD_SUBJECT} ` })).not.toBe(base);
    expect(computeOperatorEmailHash({ ...inputA, body: `${MAYFIELD_BODY} ` })).not.toBe(base);
  });
});

describe('operator email does NOT bypass Gmail/send eligibility', () => {
  const snap = (leadStatus: string): GmailEligibilitySnapshot => ({
    leadStatus,
    finalization: { finalHumanDecision: 'APPROVED', resolvedBody: 'Hello {{SENDER_NAME}}' },
    recipientEmail: 'someone@example.com',
    featureEnabled: true,
    draftActionsEnabled: true,
    credentialsConfigured: true,
    existingDraftForFingerprint: false,
  });

  it('READY_FOR_HUMAN_APPROVAL is NOT gmail-eligible', () => {
    const r = checkGmailEligibility(snap('READY_FOR_HUMAN_APPROVAL'));
    expect(r.eligible).toBe(false);
    expect(r.reasons).toContain('lead_not_human_approved:READY_FOR_HUMAN_APPROVAL');
  });

  it('even at HUMAN_APPROVED, disabled flags keep it ineligible (send stays off)', () => {
    const r = checkGmailEligibility({ ...snap('HUMAN_APPROVED'), featureEnabled: false, draftActionsEnabled: false });
    expect(r.eligible).toBe(false);
    expect(r.reasons).toEqual(expect.arrayContaining(['feature_disabled', 'gmail_draft_actions_disabled']));
  });
});
