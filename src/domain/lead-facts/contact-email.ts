/**
 * Deterministic normalization + validation for a contact_email fact value. The raw source is often a
 * captured `mailto:` evidence value that carries a query string (e.g. `?subject=New%20Enquiry:`); only the
 * BARE address may ever be persisted. No guessing, no person/title inference — this only cleans and checks
 * an address the operator explicitly supplies.
 */

/** Same shape the Gmail eligibility gate accepts as a valid recipient. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ContactEmailNormalization {
  ok: boolean;
  /** The bare, lowercased address (present only when ok). */
  value?: string;
  reason?: string;
}

/** Strip a leading `mailto:` and any `?query`/`#fragment`, trim, lowercase, then validate the bare form. */
export function normalizeContactEmail(raw: string): ContactEmailNormalization {
  const withoutScheme = raw.trim().replace(/^mailto:/i, '');
  const bare = withoutScheme.split('?')[0]?.split('#')[0]?.trim().toLowerCase() ?? '';
  if (bare.length === 0) return { ok: false, reason: 'empty_after_normalization' };
  if (!EMAIL_RE.test(bare)) return { ok: false, reason: `not_a_bare_email:${bare}` };
  return { ok: true, value: bare };
}
