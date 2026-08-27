import { describe, expect, it } from 'vitest';
import {
  allowedTransitions,
  assertTransition,
  canTransition,
  stateMachineInfo,
} from '../../src/domain/leads/state-machine.js';
import { InvalidStateTransitionError } from '../../src/utils/errors.js';
import { LEAD_STATUSES } from '../../src/domain/leads/status.js';

describe('lead state machine', () => {
  it('allows documented valid transitions', () => {
    expect(canTransition('NEW', 'NORMALIZED')).toBe(true);
    expect(canTransition('READY_FOR_QUALIFICATION', 'QUALIFIED')).toBe(true);
    expect(canTransition('EMAIL_DRAFTED', 'EMAIL_APPROVED')).toBe(true);
    expect(canTransition('EMAIL_REVIEW_FAILED', 'EMAIL_DRAFTED')).toBe(true);
    // A demo is optional: an evidence-backed lead may draft an email without a bespoke demo.
    expect(canTransition('OPPORTUNITY_READY', 'EMAIL_DRAFTED')).toBe(true);
    // The demo branches remain valid for leads that do build one.
    expect(canTransition('OPPORTUNITY_READY', 'DEMO_DECIDED')).toBe(true);
    expect(canTransition('DEMO_DECIDED', 'EMAIL_DRAFTED')).toBe(true);
    expect(canTransition('HUMAN_APPROVED', 'DRAFT_CREATED')).toBe(true);
    // Phase 13/14: a created draft is scheduled first; sending acts on the schedule.
    // There is intentionally no direct DRAFT_CREATED → SENT edge.
    expect(canTransition('DRAFT_CREATED', 'SCHEDULED')).toBe(true);
    expect(canTransition('DRAFT_CREATED', 'SENT')).toBe(false);
    expect(canTransition('SCHEDULED', 'SENT')).toBe(true);
  });

  it('rejects undocumented transitions', () => {
    expect(canTransition('NEW', 'QUALIFIED')).toBe(false);
    expect(canTransition('NEW', 'SENT')).toBe(false);
    expect(canTransition('QUALIFIED', 'NEW')).toBe(false);
    // Phase 15 manual send reconciliation is a dedicated audited transaction, never a generic edge.
    expect(canTransition('NEEDS_MANUAL_REVIEW', 'SENT')).toBe(false);
  });

  it('assertTransition throws a typed error carrying from/to', () => {
    expect(() => assertTransition('NEW', 'SENT')).toThrow(InvalidStateTransitionError);
    try {
      assertTransition('NEW', 'SENT');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidStateTransitionError);
      const typed = err as InvalidStateTransitionError;
      expect(typed.from).toBe('NEW');
      expect(typed.to).toBe('SENT');
      expect(typed.code).toBe('INVALID_STATE_TRANSITION');
    }
  });

  it('lets any active state move to UNSUBSCRIBED (suppression overrides everything)', () => {
    expect(canTransition('READY_FOR_AUDIT', 'UNSUBSCRIBED')).toBe(true);
    expect(canTransition('EMAIL_APPROVED', 'UNSUBSCRIBED')).toBe(true);
  });

  it('treats terminal states as having no outgoing transitions', () => {
    for (const terminal of ['UNSUBSCRIBED', 'FAILED', 'DUPLICATE', 'REJECTED_AUTOMATICALLY', 'REPLIED', 'BOUNCED'] as const) {
      expect(stateMachineInfo.isTerminal(terminal)).toBe(true);
      expect(allowedTransitions(terminal)).toHaveLength(0);
    }
  });

  it('keeps REJECTED terminal but allows exactly one audited recovery edge to NEEDS_MANUAL_REVIEW', () => {
    expect(stateMachineInfo.isTerminal('REJECTED')).toBe(true);
    // The single recovery edge (reopen-lead) — and nothing else.
    expect(allowedTransitions('REJECTED')).toEqual(['NEEDS_MANUAL_REVIEW']);
    expect(canTransition('REJECTED', 'NEEDS_MANUAL_REVIEW')).toBe(true);
    // No re-rejection shortcut, no suppression append, no jump back into the pipeline.
    for (const to of ['REJECTED', 'UNSUBSCRIBED', 'READY_FOR_QUALIFICATION', 'SENT'] as const) {
      expect(canTransition('REJECTED', to)).toBe(false);
    }
  });

  it('adds the deterministic bridge status with exactly its intended entry and exit edges', () => {
    // The only way IN: from NEEDS_MANUAL_REVIEW.
    expect(canTransition('NEEDS_MANUAL_REVIEW', 'OUTREACH_READY_DETERMINISTIC')).toBe(true);
    // No other state can enter it — in particular it is never reached via the AI audit path.
    for (const from of ['READY_FOR_AUDIT', 'AUDITED', 'OPPORTUNITY_READY', 'CAPTURED', 'REJECTED'] as const) {
      expect(canTransition(from, 'OUTREACH_READY_DETERMINISTIC')).toBe(false);
    }
    // Ways OUT: park back to manual review, OR advance an operator-authored email into the EXISTING
    // human-approval queue (operator-email-approve). No new send state and no forward send edge.
    expect(allowedTransitions('OUTREACH_READY_DETERMINISTIC')).toEqual(['NEEDS_MANUAL_REVIEW', 'READY_FOR_HUMAN_APPROVAL', 'UNSUBSCRIBED']);
    expect(canTransition('OUTREACH_READY_DETERMINISTIC', 'READY_FOR_HUMAN_APPROVAL')).toBe(true);
    // It never jumps into the mid-email or send states directly.
    for (const to of ['AUDITED', 'OPPORTUNITY_READY', 'DEMO_DECIDED', 'EMAIL_DRAFTED', 'EMAIL_APPROVED', 'HUMAN_APPROVED', 'DRAFT_CREATED', 'SENT'] as const) {
      expect(canTransition('OUTREACH_READY_DETERMINISTIC', to)).toBe(false);
    }
    // It is not terminal (it can be parked back for manual review).
    expect(stateMachineInfo.isTerminal('OUTREACH_READY_DETERMINISTIC')).toBe(false);
  });

  it('defines a transition entry for every status', () => {
    for (const status of LEAD_STATUSES) {
      expect(Array.isArray(allowedTransitions(status))).toBe(true);
    }
  });
});
