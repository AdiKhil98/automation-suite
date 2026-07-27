import { describe, expect, it } from 'vitest';
import {
  allowedOutreachTransitions,
  assertOutreachTransition,
  canOutreachTransition,
  cancelsFollowups,
  isOutreachTerminal,
  outreachStateMachineInfo,
} from '../../src/domain/outreach/state-machine.js';
import { OUTREACH_STATUSES } from '../../src/domain/outreach/status.js';
import { InvalidOutreachTransitionError } from '../../src/utils/errors.js';

describe('outreach state machine', () => {
  it('exposes exactly the 17 required statuses', () => {
    expect(outreachStateMachineInfo.statuses).toHaveLength(17);
    expect(OUTREACH_STATUSES).toContain('DRAFT_READY');
    expect(OUTREACH_STATUSES).toContain('CLOSED_LOST');
  });

  it('allows the happy path forward', () => {
    expect(canOutreachTransition('DRAFT_READY', 'AWAITING_APPROVAL')).toBe(true);
    expect(canOutreachTransition('AWAITING_APPROVAL', 'APPROVED_TO_SEND')).toBe(true);
    expect(canOutreachTransition('APPROVED_TO_SEND', 'INITIAL_SENT')).toBe(true);
    expect(canOutreachTransition('INITIAL_SENT', 'FOLLOW_UP_1_DUE')).toBe(true);
    expect(canOutreachTransition('FOLLOW_UP_1_DUE', 'FOLLOW_UP_1_SENT')).toBe(true);
    expect(canOutreachTransition('FOLLOW_UP_2_SENT', 'MEETING_BOOKED')).toBe(true);
    expect(canOutreachTransition('MEETING_BOOKED', 'CLOSED_WON')).toBe(true);
  });

  it('rejects illegal transitions', () => {
    expect(canOutreachTransition('DRAFT_READY', 'INITIAL_SENT')).toBe(false);
    expect(canOutreachTransition('INITIAL_SENT', 'FOLLOW_UP_2_SENT')).toBe(false);
    expect(canOutreachTransition('CLOSED_WON', 'INITIAL_SENT')).toBe(false);
    expect(() => assertOutreachTransition('DRAFT_READY', 'CLOSED_WON')).toThrow(
      InvalidOutreachTransitionError,
    );
  });

  it('permits reply/bounce/unsubscribe interrupts from any active state', () => {
    for (const from of ['INITIAL_SENT', 'FOLLOW_UP_1_DUE', 'AWAITING_APPROVAL'] as const) {
      expect(canOutreachTransition(from, 'REPLIED_POSITIVE')).toBe(true);
      expect(canOutreachTransition(from, 'BOUNCED')).toBe(true);
      expect(canOutreachTransition(from, 'UNSUBSCRIBED')).toBe(true);
      expect(canOutreachTransition(from, 'DO_NOT_CONTACT')).toBe(true);
    }
  });

  it('treats terminal states as having no outgoing transitions', () => {
    for (const t of ['UNSUBSCRIBED', 'DO_NOT_CONTACT', 'CLOSED_WON', 'CLOSED_LOST'] as const) {
      expect(isOutreachTerminal(t)).toBe(true);
      expect(allowedOutreachTransitions(t)).toHaveLength(0);
    }
  });

  it('identifies statuses that cancel follow-ups', () => {
    for (const s of ['REPLIED_POSITIVE', 'BOUNCED', 'UNSUBSCRIBED', 'DO_NOT_CONTACT', 'MEETING_BOOKED', 'CLOSED_WON', 'CLOSED_LOST'] as const) {
      expect(cancelsFollowups(s)).toBe(true);
    }
    expect(cancelsFollowups('FOLLOW_UP_1_DUE')).toBe(false);
  });
});
