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
  it('exposes exactly the 19 required statuses', () => {
    // 17 original + FOLLOW_UP_3_DUE/FOLLOW_UP_3_SENT (lesson Follow-up #4). Never a FOLLOW_UP_4_*.
    expect(outreachStateMachineInfo.statuses).toHaveLength(19);
    expect(OUTREACH_STATUSES).toContain('DRAFT_READY');
    expect(OUTREACH_STATUSES).toContain('CLOSED_LOST');
    expect(OUTREACH_STATUSES).toContain('FOLLOW_UP_3_DUE');
    expect(OUTREACH_STATUSES).toContain('FOLLOW_UP_3_SENT');
    expect(OUTREACH_STATUSES as readonly string[]).not.toContain('FOLLOW_UP_4_DUE');
    expect(OUTREACH_STATUSES as readonly string[]).not.toContain('FOLLOW_UP_4_SENT');
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

  it('walks the complete four-email sequence step by step', () => {
    const path = [
      'INITIAL_SENT', 'FOLLOW_UP_1_DUE', 'FOLLOW_UP_1_SENT',
      'FOLLOW_UP_2_DUE', 'FOLLOW_UP_2_SENT',
      'FOLLOW_UP_3_DUE', 'FOLLOW_UP_3_SENT',
    ] as const;
    for (let i = 0; i + 1 < path.length; i += 1) {
      expect(canOutreachTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it('ends the automated sequence at FOLLOW_UP_3_SENT', () => {
    // Only human-driven outcomes (plus the always-available interrupts) remain reachable; there is
    // no further DUE state, so nothing schedules another sequence email.
    const after = allowedOutreachTransitions('FOLLOW_UP_3_SENT');
    expect(after).toContain('MEETING_BOOKED');
    expect(after).toContain('CLOSED_LOST');
    expect(after.filter((s) => s.endsWith('_DUE'))).toEqual([]);
  });

  it('rejects illegal transitions', () => {
    expect(canOutreachTransition('DRAFT_READY', 'INITIAL_SENT')).toBe(false);
    expect(canOutreachTransition('INITIAL_SENT', 'FOLLOW_UP_2_SENT')).toBe(false);
    expect(canOutreachTransition('CLOSED_WON', 'INITIAL_SENT')).toBe(false);
    expect(() => assertOutreachTransition('DRAFT_READY', 'CLOSED_WON')).toThrow(
      InvalidOutreachTransitionError,
    );
  });

  it('rejects every skip within the sequence', () => {
    // A step may never be jumped: each DUE must be reached from the previous SENT.
    expect(canOutreachTransition('INITIAL_SENT', 'FOLLOW_UP_2_DUE')).toBe(false);
    expect(canOutreachTransition('INITIAL_SENT', 'FOLLOW_UP_3_DUE')).toBe(false);
    expect(canOutreachTransition('FOLLOW_UP_1_SENT', 'FOLLOW_UP_3_DUE')).toBe(false);
    expect(canOutreachTransition('FOLLOW_UP_1_DUE', 'FOLLOW_UP_2_SENT')).toBe(false);
    expect(canOutreachTransition('FOLLOW_UP_2_DUE', 'FOLLOW_UP_3_SENT')).toBe(false);
    // And the sequence never restarts or runs backwards.
    expect(canOutreachTransition('FOLLOW_UP_3_SENT', 'FOLLOW_UP_1_DUE')).toBe(false);
    expect(canOutreachTransition('FOLLOW_UP_2_SENT', 'FOLLOW_UP_1_DUE')).toBe(false);
  });

  it('permits interrupts from the new step-3 states too', () => {
    for (const from of ['FOLLOW_UP_3_DUE', 'FOLLOW_UP_3_SENT'] as const) {
      expect(canOutreachTransition(from, 'REPLIED_POSITIVE')).toBe(true);
      expect(canOutreachTransition(from, 'BOUNCED')).toBe(true);
      expect(canOutreachTransition(from, 'UNSUBSCRIBED')).toBe(true);
      expect(canOutreachTransition(from, 'DO_NOT_CONTACT')).toBe(true);
    }
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
    expect(cancelsFollowups('FOLLOW_UP_3_DUE')).toBe(false);
  });
});
