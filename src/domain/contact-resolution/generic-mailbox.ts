/**
 * Deterministic classification of an email LOCAL PART as a generic business front-door mailbox.
 *
 * This is a trust boundary, not a convenience helper: its only caller is the GENERIC_OFFICIAL
 * fallback, which addresses a business inbox that provably belongs to NO named person. It is
 * therefore deliberately CONSERVATIVE and closed by default — an unrecognized local part is
 * rejected, never accepted "because it looks harmless". A personal mailbox (`richard@`) and a
 * departmental one we must not cold-email (`billing@`) both fall out of the allowlist, and the
 * denylist additionally guarantees a system mailbox can never be reached even if someone later
 * widens the allowlist by mistake.
 *
 * Design: a small normalized ALLOWLIST of genuine business front doors + a denylist that always
 * wins, rather than a large regex. Separators are folded (`front-desk` / `front.desk` ->
 * `frontdesk`, `no-reply` / `no.reply` -> `noreply`), which collapses the spelling variants that
 * would otherwise make a regex list brittle.
 */

/** Fold separators + case so spelling variants collapse to one comparable token. */
function normalizeLocalPart(localPart: string): string {
  return localPart.trim().toLowerCase().replace(/[.\-_]/g, '');
}

/**
 * Never acceptable, whatever the allowlist says. Automated/system mailboxes (nothing human reads
 * them), legal/privacy functions (a cold pitch there is a complaint waiting to happen), and
 * departments that are categorically the wrong recipient for website/patient-enquiry outreach.
 */
const DENIED_LOCAL_PARTS = new Set([
  // Automated / system.
  'noreply', 'donotreply', 'bounce', 'bounces', 'mailerdaemon', 'postmaster', 'hostmaster',
  'unsubscribe', 'notifications', 'notification', 'alerts', 'alert', 'automated', 'autoreply',
  'daemon', 'robot', 'bot', 'system', 'root', 'webmaster', 'abuse', 'spam',
  // Legal / privacy / compliance.
  'privacy', 'dpo', 'gdpr', 'dataprotection', 'legal', 'compliance', 'security',
  // Recruitment.
  'careers', 'career', 'jobs', 'job', 'recruitment', 'recruiting', 'vacancies', 'hr', 'humanresources',
  // Finance.
  'billing', 'accounts', 'account', 'accounting', 'invoice', 'invoices', 'finance', 'payments',
  'payment', 'payroll', 'creditcontrol',
  // Bulk marketing.
  'newsletter', 'marketing', 'noreplymarketing',
]);

/** Denied whenever the local part STARTS with one of these, catching suffixed variants
 * (`noreply2024`, `donotreply-uk`) without a regex catalogue. */
const DENIED_PREFIXES = ['noreply', 'donotreply', 'mailerdaemon', 'autoreply'] as const;

/**
 * Recognized generic BUSINESS front doors — inboxes a practice publishes precisely so that an
 * unknown outsider can reach the organisation. Intentionally short: every entry is a mailbox a
 * human at the business actually reads, and none of them implies a specific named person.
 */
const GENERIC_BUSINESS_LOCAL_PARTS = new Set([
  // General front door.
  'info', 'information', 'contact', 'contactus', 'hello', 'hi', 'mail', 'office', 'general',
  'team', 'welcome', 'ask', 'admin', 'administration',
  // Enquiries.
  'enquiry', 'enquiries', 'inquiry', 'inquiries', 'newpatient', 'newpatients', 'patients',
  // Reception / front desk.
  'reception', 'frontdesk', 'desk',
  // Booking.
  'booking', 'bookings', 'appointment', 'appointments', 'reservations',
  // Practice-level.
  'practice', 'surgery', 'clinic',
]);

export type GenericMailboxRejectionReason =
  | 'empty_local_part'
  | 'plus_addressed'
  | 'denylisted_system_or_department_mailbox'
  | 'not_a_recognized_generic_business_mailbox';

export type GenericMailboxDecision =
  | { kind: 'GENERIC_BUSINESS'; normalizedLocalPart: string }
  | { kind: 'REJECTED'; reason: GenericMailboxRejectionReason };

/**
 * Classify the local part of an already-normalized, syntactically valid address. Expects the bare
 * local part (everything before `@`) — the caller owns splitting and address validation.
 */
export function classifyGenericMailbox(localPart: string): GenericMailboxDecision {
  const raw = localPart.trim().toLowerCase();
  if (raw.length === 0) return { kind: 'REJECTED', reason: 'empty_local_part' };
  // Plus-addressing is a per-recipient tag, not a published front door — refuse rather than guess
  // what the base mailbox is.
  if (raw.includes('+')) return { kind: 'REJECTED', reason: 'plus_addressed' };

  const normalized = normalizeLocalPart(raw);
  if (normalized.length === 0) return { kind: 'REJECTED', reason: 'empty_local_part' };

  // Denylist wins outright, before any allowlist consideration.
  if (DENIED_LOCAL_PARTS.has(normalized) || DENIED_PREFIXES.some((p) => normalized.startsWith(p))) {
    return { kind: 'REJECTED', reason: 'denylisted_system_or_department_mailbox' };
  }
  if (GENERIC_BUSINESS_LOCAL_PARTS.has(normalized)) {
    return { kind: 'GENERIC_BUSINESS', normalizedLocalPart: normalized };
  }
  // Closed by default: anything unrecognized (including every personal name) is not a generic inbox.
  return { kind: 'REJECTED', reason: 'not_a_recognized_generic_business_mailbox' };
}
