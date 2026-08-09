import { type ExtractedPage } from '../enrichment/types.js';
import { type LeadFact } from '../lead-facts/lead-fact.js';
import { type CaptureTarget } from './capture-types.js';

// `cap-pages-2` marks a BOOKING-AWARE selection policy: same-origin booking routes are eligible
// secondary pages (see `bookingPathLinks`). Downstream booking-absence assertions require a capture
// produced under a booking-aware version — captures under the older `cap-pages-1` cannot support a
// "no online booking" conclusion (they never looked for a booking page).
export const PAGE_SELECTION_POLICY_VERSION = 'cap-pages-2';

const SECONDARY_PATTERNS: Array<{ role: CaptureTarget['role']; re: RegExp }> = [
  { role: 'contact', re: /contact/i },
  { role: 'about', re: /about|our-practice|team/i },
  { role: 'services', re: /service|treatment|price/i },
  { role: 'booking', re: /book|appointment|consultation|reserve/i },
  { role: 'location', re: /location|find-us|branch|clinic|surgery/i },
];

function factValue(facts: LeadFact[], type: string): string | null {
  return facts.find((f) => f.factType === type && f.isCurrent)?.value ?? null;
}

/** Primary AUDIT target: location page → website URL → homepage on official domain. */
export function primaryAuditTarget(facts: LeadFact[]): CaptureTarget | null {
  const loc = factValue(facts, 'official_location_page_url');
  if (loc) return { url: loc, role: 'location' };
  const site = factValue(facts, 'official_website_url');
  if (site) return { url: site, role: 'primary' };
  const domain = factValue(facts, 'official_domain');
  if (domain) return { url: `https://${domain.replace(/^https?:\/\//, '')}`, role: 'primary' };
  return null;
}

/**
 * The same-origin link set a bounded secondary capture may consider: allowlisted contact/about/
 * location links PLUS booking-route links, contact-type first so the existing roles keep priority
 * and booking only ever fills a remaining bounded slot. Origin filtering is applied by the caller.
 */
export function secondaryLinkCandidates(page: ExtractedPage): Array<{ href: string; text: string }> {
  return [...page.sameOriginLinks, ...page.bookingPathLinks];
}

/**
 * Choose bounded secondary same-origin pages from links found on the primary page.
 * Allowlisted roles only; caller has already filtered to same verified origin.
 */
export function selectSecondaryTargets(
  links: Array<{ href: string; text: string }>,
  maxTotal: number,
): CaptureTarget[] {
  const out: CaptureTarget[] = [];
  const seenRoles = new Set<CaptureTarget['role']>();
  const seenUrls = new Set<string>();
  for (const link of links) {
    if (out.length >= maxTotal - 1) break;
    if (seenUrls.has(link.href)) continue; // a URL harvested under two roles is captured once
    for (const { role, re } of SECONDARY_PATTERNS) {
      if (seenRoles.has(role)) continue;
      if (re.test(link.href) || re.test(link.text)) {
        out.push({ url: link.href, role });
        seenRoles.add(role);
        seenUrls.add(link.href);
        break;
      }
    }
  }
  return out;
}
