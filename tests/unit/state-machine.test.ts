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
    for (const terminal of ['REJECTED', 'UNSUBSCRIBED', 'FAILED', 'DUPLICATE'] as const) {
      expect(stateMachineInfo.isTerminal(terminal)).toBe(true);
      expect(allowedTransitions(terminal)).toHaveLength(0);
    }
  });

  it('defines a transition entry for every status', () => {
    for (const status of LEAD_STATUSES) {
      expect(Array.isArray(allowedTransitions(status))).toBe(true);
    }
  });
});
