import { describe, expect, it } from 'vitest';
import { checkFollowupSendAllowed } from '../../src/domain/outreach/followup-send-gate.js';
import { type OutreachStatus } from '../../src/domain/outreach/status.js';

/**
 * The FINAL suppression re-check, run immediately before a prepared follow-up reaches the production
 * SendService. A follow-up is written and scheduled days before it is due, so the decision taken at
 * preparation time is stale by definition — these tests pin the fail-closed behaviour.
 */

const allowed = (status: OutreachStatus, preparedStep: 1 | 2 | 3 = 1, doNotContact = false) =>
  checkFollowupSendAllowed({ status, doNotContact, preparedStep });

describe('follow-up send gate — permitted', () => {
  it('allows a record still awaiting exactly this step', () => {
    expect(allowed('FOLLOW_UP_1_DUE', 1)).toEqual({ allowed: true, step: 1 });
    expect(allowed('FOLLOW_UP_2_DUE', 2)).toEqual({ allowed: true, step: 2 });
    expect(allowed('FOLLOW_UP_3_DUE', 3)).toEqual({ allowed: true, step: 3 });
  });
});

describe('follow-up send gate — suppression blocks the sequence', () => {
  it('blocks after any reply', () => {
    for (const s of ['REPLIED_POSITIVE', 'REPLIED_NEUTRAL', 'REPLIED_NEGATIVE'] as const) {
      const d = allowed(s);
      expect(d.allowed).toBe(false);
      expect(d.allowed === false && d.reason).toBe('REPLY_DETECTED');
    }
  });

  it('blocks after a permanent bounce', () => {
    const d = allowed('BOUNCED');
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.reason).toBe('BOUNCED');
  });

  it('blocks after unsubscribe and do-not-contact', () => {
    const unsub = allowed('UNSUBSCRIBED');
    expect(unsub.allowed === false && unsub.reason).toBe('UNSUBSCRIBED');
    const dnc = allowed('DO_NOT_CONTACT');
    expect(dnc.allowed === false && dnc.reason).toBe('DO_NOT_CONTACT');
  });

  it('blocks on the contact-level do-not-contact flag even when the status looks fine', () => {
    const d = allowed('FOLLOW_UP_1_DUE', 1, true);
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.reason).toBe('DO_NOT_CONTACT');
  });

  it('blocks after a booked meeting or a closed deal', () => {
    expect(allowed('MEETING_BOOKED').allowed).toBe(false);
    expect(allowed('CLOSED_WON').allowed).toBe(false);
    expect(allowed('CLOSED_LOST').allowed).toBe(false);
  });
});

describe('follow-up send gate — fail closed on anything unexpected', () => {
  it('blocks when no outreach record could be resolved', () => {
    const d = checkFollowupSendAllowed({ status: null, doNotContact: false, preparedStep: 1 });
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.reason).toBe('NO_OUTREACH_RECORD');
  });

  it('blocks a record that is not awaiting a follow-up at all', () => {
    const d = allowed('INITIAL_SENT');
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.reason).toBe('NOT_AWAITING_FOLLOWUP');
  });

  it('blocks once the sequence is finished', () => {
    const d = allowed('FOLLOW_UP_3_SENT', 3);
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.reason).toBe('NOT_AWAITING_FOLLOWUP');
  });

  it('blocks when the prepared step is not the step the record awaits', () => {
    // e.g. an older prepared step-1 email still scheduled while the record already advanced.
    const d = allowed('FOLLOW_UP_2_DUE', 1);
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.reason).toBe('STEP_MISMATCH');
  });
});
