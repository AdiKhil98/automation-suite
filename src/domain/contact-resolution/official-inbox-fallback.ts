import { type LeadFact } from '../lead-facts/lead-fact.js';
import { normalizeContactEmail } from '../lead-facts/contact-email.js';
import { classifyGenericMailbox, type GenericMailboxRejectionReason } from './generic-mailbox.js';

/**
 * The GENERIC_OFFICIAL fallback: decide whether an ALREADY-PERSISTED, website-sourced `contact_email`
 * lead fact may be used as the recipient once the personal Instantly/Hunter cascade is conclusively
 * exhausted.
 *
 * This module discovers nothing. It performs no network, provider, LLM or crawl call, spends no
 * enrichment credit, and cannot invent an address: its only input is a fact the capture/enrichment
 * pipeline already stored from the business's own website. That is precisely what makes "published,
 * never guessed" enforceable — a guessed address has no `sourceType='website'` fact to point at.
 *
 * Every acceptance condition is deterministic and independently testable; each rejection names the
 * exact rule that failed so a human reviewer can see why a lead stayed unresolved.
 */

export type GenericFallbackRejectionReason =
  | 'no_official_domain'
  | 'no_contact_email_fact'
  | 'fact_not_current'
  | 'fact_not_website_sourced'
  | 'fact_missing_source_url'
  | 'email_not_normalizable'
  | 'email_missing_local_or_domain'
  | 'email_domain_does_not_match_official_domain'
  | `mailbox_${GenericMailboxRejectionReason}`;

export type GenericFallbackDecision =
  | {
      accepted: true;
      /** Bare, lowercased address, normalized by the shared `contact_email` normalizer. */
      email: string;
      normalizedLocalPart: string;
      /** Authoritative fact this address came from — persisted as the resolution's provenance FK. */
      sourceFactId: string;
      sourceUrl: string;
    }
  | { accepted: false; reason: GenericFallbackRejectionReason };

/** Compare hosts the way the rest of the pipeline does: lowercase, `www.` stripped. */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^www\./, '');
}

/**
 * Evaluate the fallback for ONE lead.
 *
 * @param officialDomain The lead's verified `official_domain` fact value (the domain the personal
 *                       cascade also ran against). A generic inbox on any OTHER domain is refused —
 *                       a shared/agency/portal mailbox is not this business's front door.
 * @param contactEmailFact The lead's current `contact_email` fact, or null when none is stored.
 */
export function evaluateOfficialInboxFallback(
  officialDomain: string | null,
  contactEmailFact: LeadFact | null,
): GenericFallbackDecision {
  const domain = officialDomain?.trim();
  if (!domain) return { accepted: false, reason: 'no_official_domain' };
  if (!contactEmailFact || contactEmailFact.value.trim() === '') {
    return { accepted: false, reason: 'no_contact_email_fact' };
  }
  if (!contactEmailFact.isCurrent) return { accepted: false, reason: 'fact_not_current' };

  // Provenance gate. Only a fact captured FROM THE BUSINESS'S OWN WEBSITE proves the address was
  // published. 'manual'/'mock'/'google_places' provenance cannot support that claim, so an operator
  // cannot hand-enter an address and have it silently become an autonomous outreach recipient.
  if (contactEmailFact.sourceType !== 'website') {
    return { accepted: false, reason: 'fact_not_website_sourced' };
  }
  const sourceUrl = contactEmailFact.sourceUrl?.trim();
  if (!sourceUrl) return { accepted: false, reason: 'fact_missing_source_url' };

  const normalized = normalizeContactEmail(contactEmailFact.value);
  if (!normalized.ok || !normalized.value) {
    return { accepted: false, reason: 'email_not_normalizable' };
  }
  const email = normalized.value;
  const atIndex = email.lastIndexOf('@');
  const localPart = email.slice(0, atIndex);
  const emailHost = email.slice(atIndex + 1);
  if (localPart.length === 0 || emailHost.length === 0) {
    return { accepted: false, reason: 'email_missing_local_or_domain' };
  }

  // Exact host match after www-stripping. Conservative on purpose: a subdomain mailbox
  // (`info@mail.example.com` against `example.com`) is refused rather than assumed to be the same
  // organisation's front door.
  if (normalizeHost(emailHost) !== normalizeHost(domain)) {
    return { accepted: false, reason: 'email_domain_does_not_match_official_domain' };
  }

  const mailbox = classifyGenericMailbox(localPart);
  if (mailbox.kind === 'REJECTED') return { accepted: false, reason: `mailbox_${mailbox.reason}` };

  return {
    accepted: true,
    email,
    normalizedLocalPart: mailbox.normalizedLocalPart,
    sourceFactId: contactEmailFact.id,
    sourceUrl,
  };
}
