/**
 * Durable "scheduled send authorization" — the bounded, revocable, capped, policy-version-bound
 * human pre-authorization that replaces the interactive per-send readiness/TTY for AUTOMATED sends
 * ONLY. It does NOT touch the manual send path. A human creates one (via `approve-scheduled-send`)
 * for the pilot window; the automated runner derives its session readiness from a VALID one.
 */

/** Hard upper bound on an authorization's lifetime (defense-in-depth alongside the DB CHECK). */
export const SCHEDULED_SEND_AUTH_MAX_DAYS = 14;
export const SCHEDULED_SEND_AUTH_MAX_MS = SCHEDULED_SEND_AUTH_MAX_DAYS * 24 * 60 * 60_000;

export interface ScheduledSendAuthorization {
  id: string;
  gmailAccount: string;
  policyVersion: string;
  startsAt: Date;
  expiresAt: Date;
  maxPerDay: number;
  createdBy: string;
  revokedAt: Date | null;
}

export type AuthorizationInvalidReason =
  | 'revoked'
  | 'not_started'
  | 'expired'
  | 'account_mismatch'
  | 'policy_mismatch'
  | 'exceeds_max_lifetime'
  | 'invalid_cap';

function normalize(v: string): string {
  return v.trim().toLowerCase();
}

/**
 * Every reason a durable authorization is NOT usable right now (empty ⇒ valid). Fail-closed: an
 * authorization is usable only if it is non-revoked, within [startsAt, expiresAt), matches the exact
 * account + policy version, sits within the max lifetime, and carries a positive per-day cap.
 */
export function authorizationInvalidReasons(
  auth: ScheduledSendAuthorization,
  nowMs: number,
  gmailAccount: string,
  policyVersion: string,
): AuthorizationInvalidReason[] {
  const reasons: AuthorizationInvalidReason[] = [];
  if (auth.revokedAt !== null) reasons.push('revoked');
  if (auth.startsAt.getTime() > nowMs) reasons.push('not_started');
  if (nowMs >= auth.expiresAt.getTime()) reasons.push('expired');
  if (normalize(auth.gmailAccount) !== normalize(gmailAccount)) reasons.push('account_mismatch');
  if (auth.policyVersion !== policyVersion) reasons.push('policy_mismatch');
  if (auth.expiresAt.getTime() - auth.startsAt.getTime() > SCHEDULED_SEND_AUTH_MAX_MS) reasons.push('exceeds_max_lifetime');
  if (!Number.isInteger(auth.maxPerDay) || auth.maxPerDay < 1) reasons.push('invalid_cap');
  return reasons;
}

export function isAuthorizationValid(
  auth: ScheduledSendAuthorization,
  nowMs: number,
  gmailAccount: string,
  policyVersion: string,
): boolean {
  return authorizationInvalidReasons(auth, nowMs, gmailAccount, policyVersion).length === 0;
}

export interface NewAuthorizationInput {
  gmailAccount: string;
  policyVersion: string;
  createdBy: string;
  startsAtMs: number;
  expiresAtMs: number;
  maxPerDay: number;
}

/** Validate a NEW authorization before persistence (bounded lifetime, positive cap, sane window). */
export function validateNewAuthorization(input: NewAuthorizationInput): string[] {
  const errors: string[] = [];
  if (!input.gmailAccount.trim()) errors.push('gmail_account_required');
  if (!input.policyVersion.trim()) errors.push('policy_version_required');
  if (!input.createdBy.trim()) errors.push('created_by_required');
  if (input.expiresAtMs <= input.startsAtMs) errors.push('expiry_must_be_after_start');
  if (input.expiresAtMs - input.startsAtMs > SCHEDULED_SEND_AUTH_MAX_MS) errors.push(`lifetime_exceeds_${String(SCHEDULED_SEND_AUTH_MAX_DAYS)}_days`);
  if (!Number.isInteger(input.maxPerDay) || input.maxPerDay < 1) errors.push('max_per_day_must_be_positive_integer');
  return errors;
}
