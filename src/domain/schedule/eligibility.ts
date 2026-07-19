import { isValidTimeZone } from './timezone.js';

/** Snapshot the scheduling eligibility gate inspects (all from persisted state + config). */
export interface ScheduleEligibilitySnapshot {
  leadStatus: string;
  /** The Gmail draft record for this lead (must be a created draft with a provider id). */
  gmailDraft: { outcome: string; providerDraftId: string | null } | null;
  /** The approved finalized email's content hash (binds the schedule to the exact content). */
  finalizedContentHash: string | null;
  /** Verified recipient address (from a contact_email fact) — never guessed. */
  recipientEmail: string | null;
  /** Recipient's verified IANA timezone (from a contact_timezone fact) — REQUIRED. */
  timezone: string | null;
  featureEnabled: boolean;
  /** True if an active (SCHEDULED) schedule already exists for this draft. */
  hasActiveSchedule: boolean;
}

export interface ScheduleEligibilityResult {
  eligible: boolean;
  /** A schedule already exists — reuse, not a failure. */
  duplicateReusable: boolean;
  /** True when a fail-closed timezone problem should route the lead to manual review. */
  timezoneProblem: boolean;
  reasons: string[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Deterministic scheduling eligibility (fail-closed). A draft may be scheduled only when the
 * lead is DRAFT_CREATED, its Gmail draft was actually created (provider id present), the approved
 * finalized content hash + verified recipient exist, and a VALID recipient IANA timezone is on
 * file. A missing/ambiguous/invalid timezone fails closed (routes to manual review). An existing
 * active schedule is a reuse, not a failure. No sending is implied.
 */
export function checkScheduleEligibility(s: ScheduleEligibilitySnapshot): ScheduleEligibilityResult {
  const reasons: string[] = [];
  let timezoneProblem = false;

  if (!s.featureEnabled) reasons.push('scheduling_disabled');
  if (s.leadStatus !== 'DRAFT_CREATED') reasons.push(`lead_not_draft_created:${s.leadStatus}`);

  if (!s.gmailDraft) reasons.push('no_gmail_draft');
  else {
    if (s.gmailDraft.outcome !== 'DRAFT_CREATED') reasons.push(`gmail_draft_not_created:${s.gmailDraft.outcome}`);
    if (!s.gmailDraft.providerDraftId) reasons.push('no_provider_draft_id');
  }

  if (!s.finalizedContentHash) reasons.push('no_finalized_content_hash');
  if (!s.recipientEmail) reasons.push('no_verified_recipient');
  else if (!EMAIL_RE.test(s.recipientEmail)) reasons.push('recipient_not_valid_email');

  if (!s.timezone) { reasons.push('missing_timezone'); timezoneProblem = true; }
  else if (!isValidTimeZone(s.timezone)) { reasons.push('invalid_timezone'); timezoneProblem = true; }

  if (s.hasActiveSchedule) {
    return { eligible: false, duplicateReusable: true, timezoneProblem: false, reasons: ['active_schedule_exists'] };
  }
  return { eligible: reasons.length === 0, duplicateReusable: false, timezoneProblem, reasons };
}
