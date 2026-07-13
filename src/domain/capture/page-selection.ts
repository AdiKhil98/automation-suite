import { type LeadFact } from '../lead-facts/lead-fact.js';
import { type CaptureTarget } from './capture-types.js';

export const PAGE_SELECTION_POLICY_VERSION = 'cap-pages-1';

const SECONDARY_PATTERNS: Array<{ role: CaptureTarget['role']; re: RegExp }> = [
  { role: 'contact', re: /contact/i },
  { role: 'about', re: /about|our-practice|team/i },
  { role: 'services', re: /service|treatment|price/i },
  { role: 'booking', re: /book|appointment/i },
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
 * Choose bounded secondary same-origin pages from links found on the primary page.
 * Allowlisted roles only; caller has already filtered to same verified origin.
 */
export function selectSecondaryTargets(
  links: Array<{ href: string; text: string }>,
  maxTotal: number,
): CaptureTarget[] {
  const out: CaptureTarget[] = [];
  const seenRoles = new Set<CaptureTarget['role']>();
  for (const link of links) {
    if (out.length >= maxTotal - 1) break;
    for (const { role, re } of SECONDARY_PATTERNS) {
      if (seenRoles.has(role)) continue;
      if (re.test(link.href) || re.test(link.text)) {
        out.push({ url: link.href, role });
        seenRoles.add(role);
        break;
      }
    }
  }
  return out;
}
