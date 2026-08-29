import { normalizeContactEmail } from '../lead-facts/contact-email.js';
import { type ProviderEnrichmentOutcome, type ReturnedIdentity, type VerifiedContact, type CandidatePerson, type PreviewPerson } from './types.js';

/**
 * Deterministic accept/reject for a single provider outcome. This is the trust boundary: an email
 * may reach autonomous outreach ONLY through here, and ONLY when the provider reports it VERIFIED,
 * it is a syntactically valid bare address, it is NOT a generic role/mailbox address, its host
 * matches the requested company domain, AND the returned person's name/title match the requested
 * candidate. Nothing here guesses or repairs an address. A rejected outcome yields no contact.
 */

/** Role/mailbox local-parts we refuse even if a provider marks them verified (no info@ fallback). */
const GENERIC_LOCAL_PARTS = new Set([
  'info', 'admin', 'office', 'reception', 'hello', 'contact', 'enquiries', 'enquiry',
  'support', 'help', 'team', 'mail', 'email', 'sales', 'bookings', 'booking', 'appointments',
  'appointment', 'practice', 'frontdesk', 'front-desk', 'noreply', 'no-reply', 'donotreply',
]);

/** Title tokens that carry no discriminating signal when comparing titles. */
const TITLE_STOPWORDS = new Set(['the', 'of', 'and', 'a', 'an', '&', 'at', 'our']);

export interface AcceptanceDecision {
  accepted: boolean;
  reason: string;
  contact: VerifiedContact | null;
  /** Per-field match results, always recorded for provenance (even on reject). */
  match: { name: boolean; domain: boolean; title: 'match' | 'mismatch' | 'unconfirmed' };
}

const norm = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();
const hostOf = (email: string): string => email.split('@')[1]?.toLowerCase() ?? '';
const stripWww = (d: string): string => d.replace(/^www\./, '');

/** True when the local-part is a generic role mailbox rather than a person. */
export function isGenericMailbox(email: string): boolean {
  const local = email.split('@')[0]?.toLowerCase() ?? '';
  if (GENERIC_LOCAL_PARTS.has(local)) return true;
  const base = local.split(/[+._-]/)[0] ?? local;
  return GENERIC_LOCAL_PARTS.has(base);
}

export interface PreviewMatch {
  name: boolean;
  domain: boolean;
  title: 'match' | 'mismatch' | 'unconfirmed';
  isMatch: boolean;
}

/**
 * Local match of a previewed person (no email yet) against a requested candidate. Name must match and
 * the title must not conflict; domain must match when the preview row carries one (the search is
 * domain-scoped, so a missing preview domain is accepted). Used to decide whether a PAID enrichment
 * is justified — it never accepts an email on its own.
 */
export function matchPreviewPerson(person: PreviewPerson, candidate: CandidatePerson, requestedDomain: string): PreviewMatch {
  const name = nameMatches(person, candidate);
  const want = stripWww(norm(requestedDomain));
  const domain = person.domain ? stripWww(norm(person.domain)) === want : true;
  const title = titleMatch(person, candidate);
  return { name, domain, title, isMatch: name && domain && title !== 'mismatch' };
}

/** Name matches when both first and last (honorific-free) tokens agree. */
function nameMatches(identity: ReturnedIdentity, person: CandidatePerson): boolean {
  const wantFirst = norm(person.firstName);
  const wantLast = norm(person.lastName);
  if (identity.firstName && identity.lastName) {
    return norm(identity.firstName) === wantFirst && norm(identity.lastName) === wantLast;
  }
  const full = norm(identity.name);
  if (!full) return false;
  const tokens = full.split(/\s+/);
  return tokens.includes(wantFirst) && tokens.includes(wantLast);
}

/** Domain matches when the returned domain (or the email host) equals the requested domain (www-insensitive). */
function domainMatches(identity: ReturnedIdentity, email: string, requestedDomain: string): boolean {
  const want = stripWww(norm(requestedDomain));
  const fromIdentity = stripWww(norm(identity.domain));
  const fromEmail = stripWww(hostOf(email));
  return fromEmail === want || (fromIdentity !== '' && fromIdentity === want);
}

/** Title comparison: shared significant token => match; a present-but-disjoint title => mismatch; absent => unconfirmed. */
function titleMatch(identity: ReturnedIdentity, person: CandidatePerson): 'match' | 'mismatch' | 'unconfirmed' {
  const got = norm(identity.title);
  if (!got) return 'unconfirmed';
  const sig = (s: string): Set<string> => new Set(s.split(/[^a-z]+/).filter((t) => t.length > 2 && !TITLE_STOPWORDS.has(t)));
  const want = sig(norm(person.title));
  const have = sig(got);
  if (want.size === 0) return 'unconfirmed';
  for (const t of want) if (have.has(t)) return 'match';
  return 'mismatch';
}

/**
 * Decide whether a provider outcome yields a usable verified decision-maker contact.
 * `person` supplies the requested identity; `requestedDomain` is the company domain we searched.
 */
export function decideAcceptance(
  outcome: ProviderEnrichmentOutcome,
  person: CandidatePerson,
  requestedDomain: string,
): AcceptanceDecision {
  const emptyMatch = { name: false, domain: false, title: 'unconfirmed' as const };
  if (outcome.verificationStatus !== 'VERIFIED') {
    return { accepted: false, reason: `not_verified:${outcome.verificationStatus}`, contact: null, match: emptyMatch };
  }
  if (!outcome.email) {
    return { accepted: false, reason: 'verified_but_no_email', contact: null, match: emptyMatch };
  }
  const normd = normalizeContactEmail(outcome.email);
  if (!normd.ok || !normd.value) {
    return { accepted: false, reason: normd.reason ?? 'invalid_email', contact: null, match: emptyMatch };
  }
  const email = normd.value;
  if (isGenericMailbox(email)) {
    return { accepted: false, reason: 'generic_mailbox_rejected', contact: null, match: emptyMatch };
  }
  const identity = outcome.returnedIdentity;
  if (!identity) {
    return { accepted: false, reason: 'no_returned_identity_to_validate', contact: null, match: emptyMatch };
  }
  const nameOk = nameMatches(identity, person);
  const domainOk = domainMatches(identity, email, requestedDomain);
  const titleResult = titleMatch(identity, person);
  const match = { name: nameOk, domain: domainOk, title: titleResult };

  if (!nameOk) return { accepted: false, reason: 'name_mismatch', contact: null, match };
  if (!domainOk) return { accepted: false, reason: 'domain_mismatch', contact: null, match };
  if (titleResult === 'mismatch') return { accepted: false, reason: 'title_mismatch', contact: null, match };

  return {
    accepted: true,
    reason: 'verified_and_matched',
    contact: {
      fullName: person.fullName,
      title: person.title,
      email,
      verificationStatus: 'VERIFIED',
      dataQuality: outcome.dataQuality,
      confidence: outcome.confidence,
    },
    match,
  };
}
