import { describe, expect, it } from 'vitest';
import {
  authorizationInvalidReasons,
  isAuthorizationValid,
  SCHEDULED_SEND_AUTH_MAX_MS,
  type ScheduledSendAuthorization,
  validateNewAuthorization,
} from '../../src/domain/send/scheduled-send-authorization.js';

const NOW = Date.parse('2026-08-20T09:15:00Z');
const ACC = 'admin@scaleflow.it.com';
const POLICY = 'send-policy-1';

function auth(overrides: Partial<ScheduledSendAuthorization> = {}): ScheduledSendAuthorization {
  return {
    id: 'auth-1',
    gmailAccount: ACC,
    policyVersion: POLICY,
    startsAt: new Date(NOW - 60_000),
    expiresAt: new Date(NOW + 7 * 24 * 60 * 60_000),
    maxPerDay: 2,
    createdBy: 'adi',
    revokedAt: null,
    ...overrides,
  };
}

describe('scheduled-send authorization validity', () => {
  it('accepts a bounded, in-window, matching, capped authorization', () => {
    expect(authorizationInvalidReasons(auth(), NOW, ACC, POLICY)).toEqual([]);
    expect(isAuthorizationValid(auth(), NOW, ACC, POLICY)).toBe(true);
  });

  it('fails closed on revoked / not-started / expired', () => {
    expect(authorizationInvalidReasons(auth({ revokedAt: new Date(NOW) }), NOW, ACC, POLICY)).toContain('revoked');
    expect(authorizationInvalidReasons(auth({ startsAt: new Date(NOW + 60_000) }), NOW, ACC, POLICY)).toContain('not_started');
    expect(authorizationInvalidReasons(auth({ expiresAt: new Date(NOW - 1) }), NOW, ACC, POLICY)).toContain('expired');
  });

  it('fails closed on account / policy mismatch', () => {
    expect(authorizationInvalidReasons(auth(), NOW, 'other@x.com', POLICY)).toContain('account_mismatch');
    expect(authorizationInvalidReasons(auth(), NOW, ACC, 'send-policy-2')).toContain('policy_mismatch');
  });

  it('fails closed when the lifetime exceeds the 14-day max or the cap is not positive', () => {
    const tooLong = auth({ startsAt: new Date(NOW - 60_000), expiresAt: new Date(NOW - 60_000 + SCHEDULED_SEND_AUTH_MAX_MS + 60_000) });
    expect(authorizationInvalidReasons(tooLong, NOW, ACC, POLICY)).toContain('exceeds_max_lifetime');
    expect(authorizationInvalidReasons(auth({ maxPerDay: 0 }), NOW, ACC, POLICY)).toContain('invalid_cap');
  });
});

describe('validateNewAuthorization', () => {
  it('accepts a valid 14-day / cap-2 authorization', () => {
    expect(validateNewAuthorization({ gmailAccount: ACC, policyVersion: POLICY, createdBy: 'adi', startsAtMs: NOW, expiresAtMs: NOW + SCHEDULED_SEND_AUTH_MAX_MS, maxPerDay: 2 })).toEqual([]);
  });
  it('rejects a lifetime over 14 days, a non-positive cap, and an inverted window', () => {
    expect(validateNewAuthorization({ gmailAccount: ACC, policyVersion: POLICY, createdBy: 'adi', startsAtMs: NOW, expiresAtMs: NOW + SCHEDULED_SEND_AUTH_MAX_MS + 1, maxPerDay: 2 })).toContain('lifetime_exceeds_14_days');
    expect(validateNewAuthorization({ gmailAccount: ACC, policyVersion: POLICY, createdBy: 'adi', startsAtMs: NOW, expiresAtMs: NOW + 1000, maxPerDay: 0 })).toContain('max_per_day_must_be_positive_integer');
    expect(validateNewAuthorization({ gmailAccount: ACC, policyVersion: POLICY, createdBy: 'adi', startsAtMs: NOW, expiresAtMs: NOW - 1, maxPerDay: 2 })).toContain('expiry_must_be_after_start');
  });
});
