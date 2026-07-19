import { SENDER_NAME_TOKEN } from './mime.js';

/** Snapshot the Gmail-draft eligibility gate inspects (all from persisted state + config). */
export interface GmailEligibilitySnapshot {
  leadStatus: string;
  /** The approved finalized email (Phase 11), or null. */
  finalization: { finalHumanDecision: string | null; resolvedBody: string } | null;
  /** Verified recipient address (from a contact_email fact), or null — NEVER guessed. */
  recipientEmail: string | null;
  featureEnabled: boolean;
  /** Repository-wide outbound kill switch; draft creation is blocked unless explicitly armed. */
  outboundActionsEnabled: boolean;
  credentialsConfigured: boolean;
  /** True if a Gmail draft already exists for this (account + finalized email + recipient). */
  existingDraftForFingerprint: boolean;
}

export interface GmailEligibilityResult {
  eligible: boolean;
  duplicateReusable: boolean;
  reasons: string[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Deterministic Gmail-draft eligibility gate (fail-closed). A draft is created only for a
 * HUMAN_APPROVED lead whose finalized email is human-approved, whose body has NO leftover
 * {{DEMO_URL}} (Phase 11 guarantee) — only {{SENDER_NAME}} may remain, to be resolved — and
 * for which a VERIFIED recipient address exists. A pre-existing draft for the same fingerprint
 * is a reuse, not a failure. Recipient addresses are never invented.
 */
export function checkGmailEligibility(s: GmailEligibilitySnapshot): GmailEligibilityResult {
  const reasons: string[] = [];

  if (!s.featureEnabled) reasons.push('feature_disabled');
  if (!s.outboundActionsEnabled) reasons.push('outbound_actions_disabled');
  if (!s.credentialsConfigured) reasons.push('credentials_missing');
  if (s.leadStatus !== 'HUMAN_APPROVED') reasons.push(`lead_not_human_approved:${s.leadStatus}`);

  if (!s.finalization) reasons.push('no_finalized_email');
  else {
    if (s.finalization.finalHumanDecision !== 'APPROVED') reasons.push(`finalized_not_approved:${s.finalization.finalHumanDecision ?? 'none'}`);
    if (s.finalization.resolvedBody.includes('{{DEMO_URL}}')) reasons.push('unresolved_demo_url');
    // Any handlebar token other than the sender-name placeholder must not be present.
    const stripped = s.finalization.resolvedBody.split(SENDER_NAME_TOKEN).join('');
    if (/\{\{[A-Za-z0-9_]+\}\}/.test(stripped)) reasons.push('unexpected_unresolved_token');
  }

  if (!s.recipientEmail) reasons.push('no_verified_recipient');
  else if (!EMAIL_RE.test(s.recipientEmail)) reasons.push('recipient_not_valid_email');

  if (s.existingDraftForFingerprint) {
    return { eligible: false, duplicateReusable: true, reasons: ['duplicate_draft_exists'] };
  }
  return { eligible: reasons.length === 0, duplicateReusable: false, reasons };
}
