const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A minimal read-only view of the active schedule the send would act on. */
export interface ScheduleView {
  id: string;
  status: string; // must be 'SCHEDULED' (active)
  gmailDraftId: string;
  providerDraftId: string;
  finalizedContentHash: string;
  recipientEmail: string;
  scheduledAtUtcMs: number;
  rulesVersion: string;
  storedIntegrityFingerprint: string;
}

/** A readiness approval as inspected by the gate (no secrets). */
export interface ReadinessView {
  id: string;
  gmailAccount: string;
  policyVersion: string;
  approvedAtMs: number;
  expiresAtMs: number;
  revoked: boolean;
}

/** The operator's explicit confirmation of a specific envelope. */
export interface ConfirmationView {
  observedSendFingerprint: string;
  confirmedBy: string;
  confirmedAtMs: number;
}

/** Everything the fail-closed sending gate inspects — all from persisted state + config +
 * the operator's confirmation. Nothing here is inferred or guessed. */
export interface SendEligibilitySnapshot {
  leadStatus: string;
  schedule: ScheduleView | null;
  /** Integrity fingerprint recomputed from the CURRENT bound values (draft/content/recipient/
   * time/rules). Must equal `schedule.storedIntegrityFingerprint` or the binding is stale. */
  recomputedIntegrityFingerprint: string | null;
  currentGmailDraft: { outcome: string; providerDraftId: string | null } | null;
  currentFinalizedContentHash: string | null;
  currentRecipientEmail: string | null;
  finalizationApproved: boolean;
  draftBindingValid: boolean;
  gmailAccountMatches: boolean;
  draftRecipientMatches: boolean;
  recipientSuppressed: boolean;
  readiness: ReadinessView | null;
  confirmation: ConfirmationView | null;
  /** The envelope hash the send would use (computed from current account/recipient/subject/
   * content/schedule). The operator's `confirmation.observedEnvelopeHash` must match it. */
  approvedEnvelopeHash: string;
  expectedSendFingerprint: string;
  configGmailAccount: string;
  configPolicyVersion: string;
  // --- kill switches (all must be armed; they stay OFF in the default environment) ---
  sendingEnabled: boolean;
  outboundActionsEnabled: boolean;
  dryRun: boolean;
  // --- timing + duplicate signals ---
  nowMs: number;
  maxLateMs: number;
  confirmationTtlMs: number;
  hasConfirmedAttempt: boolean;
  hasBlockingAttempt: boolean;
  lastDefinitiveFailureAtMs: number | null;
  confirmedSendsToday: number;
  dailyCap: number;
}

export interface SendEligibilityResult {
  eligible: boolean;
  reasons: string[];
  /** A durable binding mismatch — the schedule must be INVALIDATED (not merely blocked). */
  bindingInvalid: boolean;
  /** The scheduled instant has not been reached yet — retry later, no state change. */
  notDue: boolean;
  /** Past the acceptable lateness window — the schedule must be INVALIDATED. */
  tooLate: boolean;
  /** The recipient is on the email suppression list — route to manual review. */
  suppressed: boolean;
  /** A confirmed send already exists for this schedule. */
  alreadySent: boolean;
  /** A non-confirmed blocking attempt exists (RESERVED/CALL_STARTED/OUTCOME_UNKNOWN). */
  blocked: boolean;
  /** Only kill-switch flags failed (nothing else) — an inert/disabled environment. */
  flagsOnly: boolean;
}

/**
 * Deterministic controlled-sending eligibility (fail-closed). A single created Gmail draft may be
 * dispatched only when EVERY condition holds:
 *  - all three kill switches are armed (SENDING_ENABLED, OUTBOUND_ACTIONS_ENABLED, DRY_RUN=false);
 *  - the lead is SCHEDULED and an active SCHEDULED schedule exists;
 *  - the schedule's integrity binding still matches the current draft/content/recipient/time/rules;
 *  - the created Gmail draft (with a provider id), approved finalized content, and a VERIFIED,
 *    NON-suppressed recipient are present;
 *  - a valid, unexpired, unrevoked readiness approval for the exact account + policy version exists;
 *  - the operator supplied a FRESH explicit confirmation of the EXACT approved envelope;
 *  - the scheduled instant has been reached and is not past the max-late window;
 *  - no confirmed or blocking send attempt already exists for the schedule.
 * Anything missing or mismatched fails closed. No send is ever implied by this function alone.
 */
export function checkSendEligibility(s: SendEligibilitySnapshot, options: { requireConfirmation?: boolean } = {}): SendEligibilityResult {
  const reasons: string[] = [];

  // Duplicate short-circuits (safety first).
  if (s.hasConfirmedAttempt) {
    return { ...base(false), alreadySent: true, reasons: ['already_sent'] };
  }
  if (s.hasBlockingAttempt) {
    return { ...base(false), blocked: true, reasons: ['blocking_attempt_exists'] };
  }

  if (s.confirmedSendsToday >= s.dailyCap) reasons.push('daily_cap_reached');

  const flagReasons: string[] = [];
  if (!s.sendingEnabled) flagReasons.push('sending_disabled');
  if (!s.outboundActionsEnabled) flagReasons.push('outbound_actions_disabled');
  if (s.dryRun) flagReasons.push('dry_run_enabled');
  reasons.push(...flagReasons);

  if (s.leadStatus !== 'SCHEDULED') reasons.push(`lead_not_scheduled:${s.leadStatus}`);

  if (!s.schedule) {
    reasons.push('no_active_schedule');
  } else if (s.schedule.status !== 'SCHEDULED') {
    reasons.push(`schedule_not_active:${s.schedule.status}`);
  }

  if (!s.currentGmailDraft) reasons.push('no_gmail_draft');
  else {
    if (s.currentGmailDraft.outcome !== 'DRAFT_CREATED') reasons.push(`gmail_draft_not_created:${s.currentGmailDraft.outcome}`);
    if (!s.currentGmailDraft.providerDraftId) reasons.push('no_provider_draft_id');
  }

  if (!s.currentFinalizedContentHash) reasons.push('no_finalized_content_hash');
  if (!s.finalizationApproved) reasons.push('finalized_email_not_approved');
  if (!s.draftBindingValid) reasons.push('draft_finalization_mismatch');
  if (!s.gmailAccountMatches) reasons.push('gmail_account_mismatch');
  if (!s.draftRecipientMatches) reasons.push('draft_recipient_mismatch');
  if (!s.currentRecipientEmail) reasons.push('no_verified_recipient');
  else if (!EMAIL_RE.test(s.currentRecipientEmail)) reasons.push('recipient_not_valid_email');

  // Binding integrity — a durable mismatch, not a transient block.
  let bindingInvalid = false;
  if (s.schedule && (s.recomputedIntegrityFingerprint === null || s.recomputedIntegrityFingerprint !== s.schedule.storedIntegrityFingerprint)) {
    bindingInvalid = true;
    reasons.push('binding_invalidated');
  }

  let suppressed = false;
  if (s.recipientSuppressed) {
    suppressed = true;
    reasons.push('recipient_suppressed');
  }

  // Readiness approval.
  if (!s.readiness) reasons.push('no_sending_readiness');
  else {
    if (s.readiness.revoked) reasons.push('readiness_revoked');
    if (normalize(s.readiness.gmailAccount) !== normalize(s.configGmailAccount)) reasons.push('readiness_account_mismatch');
    if (s.readiness.policyVersion !== s.configPolicyVersion) reasons.push('readiness_policy_mismatch');
    if (s.readiness.approvedAtMs > s.nowMs) reasons.push('readiness_in_future');
    if (s.nowMs >= s.readiness.expiresAtMs) reasons.push('readiness_expired');
    if (s.lastDefinitiveFailureAtMs !== null && s.readiness.approvedAtMs <= s.lastDefinitiveFailureAtMs) reasons.push('fresh_readiness_required');
  }

  // Explicit fresh confirmation of the exact envelope.
  if (options.requireConfirmation !== false && !s.confirmation) reasons.push('no_confirmation');
  else if (options.requireConfirmation !== false && s.confirmation) {
    if (s.confirmation.observedSendFingerprint !== s.expectedSendFingerprint) reasons.push('confirmation_fingerprint_mismatch');
    if (s.confirmation.confirmedAtMs > s.nowMs) reasons.push('confirmation_in_future');
    else if (s.nowMs - s.confirmation.confirmedAtMs > s.confirmationTtlMs) reasons.push('confirmation_expired');
  }

  // Timing window.
  let notDue = false;
  let tooLate = false;
  if (s.schedule) {
    if (s.nowMs < s.schedule.scheduledAtUtcMs) {
      notDue = true;
      reasons.push('not_due');
    } else if (s.nowMs - s.schedule.scheduledAtUtcMs > s.maxLateMs) {
      tooLate = true;
      reasons.push('too_late');
    }
  }

  const eligible = reasons.length === 0;
  const flagsOnly = !eligible && reasons.every((r) => flagReasons.includes(r));
  return { eligible, reasons, bindingInvalid, notDue, tooLate, suppressed, alreadySent: false, blocked: false, flagsOnly };
}

function normalize(v: string): string {
  return v.trim().toLowerCase();
}

function base(eligible: boolean): SendEligibilityResult {
  return { eligible, reasons: [], bindingInvalid: false, notDue: false, tooLate: false, suppressed: false, alreadySent: false, blocked: false, flagsOnly: false };
}
