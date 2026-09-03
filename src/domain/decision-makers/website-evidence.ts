import * as cheerio from 'cheerio';
import { safeGetHtml, type FetchOutcome, type SafeGetOptions } from '../../utils/safe-fetch.js';

/**
 * Bounded, SSRF-safe evidence gathering from ONE lead's own verified official website. Reuses
 * `safeGetHtml` (the same hardened GET used by the Phase-4 domain verifier) as-is for fetching.
 * Deliberately does NOT reuse `extractPage()`/`sameOriginLinks` from `src/domain/enrichment/extract.ts`:
 * that link filter (`CONTACT_PATH_RE`) has no "team" keyword (a page titled/linked "Meet the Team" is
 * never harvested), and its `visibleTextSample` is lowercased/bluntly truncated — unsuited to readable
 * evidence snippets. Both gaps matter here, so this module does its own small cheerio pass instead of
 * widening that SHARED regex (which also drives the Phase-4 verifier and Playwright secondary-page
 * selection) — a change there would alter unrelated pipelines.
 */

export type PageFetchFn = (url: string) => Promise<FetchOutcome>;

export function buildSafeHttpFetcher(opts: SafeGetOptions): PageFetchFn {
  return (url) => safeGetHtml(url, opts);
}

export interface EvidencePage {
  role: 'home' | 'team' | 'contact';
  url: string;
  text: string;
}

export interface GatherEvidenceResult {
  pages: EvidencePage[];
  fetchErrors: string[];
}

const TEAM_LINK_RE = /team|about|our-practice|meet|staff|doctors|dentists|clinicians|who-we-are/i;
const CONTACT_LINK_RE = /contact/i;
const MAX_TEXT_CHARS_PER_PAGE = 4000;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** True when `candidateHost` is the official host or a subdomain of it. */
function isSameOfficialSite(candidateHost: string | null, officialHost: string): boolean {
  if (!candidateHost) return false;
  return candidateHost === officialHost || candidateHost.endsWith(`.${officialHost}`);
}

/** Extract case-preserving visible body text + role-matched same-origin links from raw HTML. */
function extractTextAndLinks(html: string, pageUrl: string, officialHost: string): { text: string; teamLink: string | null; contactLink: string | null } {
  const $ = cheerio.load(html);
  $('script, style, noscript, template').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS_PER_PAGE);

  let teamLink: string | null = null;
  let contactLink: string | null = null;
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const linkText = $(el).text().replace(/\s+/g, ' ').trim();
    let abs: string;
    try {
      abs = new URL(href, pageUrl).toString();
    } catch {
      return;
    }
    if (!isSameOfficialSite(hostOf(abs), officialHost)) return; // unofficial/external source — never harvested
    const haystack = `${abs} ${linkText}`;
    if (!teamLink && TEAM_LINK_RE.test(haystack)) teamLink = abs;
    if (!contactLink && CONTACT_LINK_RE.test(haystack)) contactLink = abs;
  });
  return { text, teamLink, contactLink };
}

/**
 * Fetch the homepage of `baseUrl`, discover at most one team-like and one contact-like same-origin
 * link, and fetch those too — bounded by `maxPages` total (default callers pass
 * DISCOVER_DECISION_MAKERS_MAX_PAGES_PER_LEAD). A failed/blocked secondary page degrades to "missing"
 * rather than aborting; a failed homepage fetch yields zero pages (recorded as a fetch error).
 */
export async function gatherWebsiteEvidence(fetch: PageFetchFn, baseUrl: string, maxPages: number): Promise<GatherEvidenceResult> {
  const officialHost = hostOf(baseUrl);
  const fetchErrors: string[] = [];
  if (!officialHost) {
    return { pages: [], fetchErrors: [`invalid official website URL: ${baseUrl}`] };
  }

  const home = await fetch(baseUrl);
  if (home.kind !== 'ok') {
    fetchErrors.push(`homepage fetch ${home.kind}: ${home.reason}`);
    return { pages: [], fetchErrors };
  }
  const homeExtract = extractTextAndLinks(home.html, home.finalUrl, officialHost);
  const pages: EvidencePage[] = [{ role: 'home', url: home.finalUrl, text: homeExtract.text }];

  const secondary: Array<{ role: 'team' | 'contact'; url: string }> = [];
  if (homeExtract.teamLink) secondary.push({ role: 'team', url: homeExtract.teamLink });
  if (homeExtract.contactLink) secondary.push({ role: 'contact', url: homeExtract.contactLink });

  for (const target of secondary) {
    if (pages.length >= maxPages) break;
    const res = await fetch(target.url);
    if (res.kind !== 'ok') {
      fetchErrors.push(`${target.role} page fetch ${res.kind}: ${res.reason}`);
      continue;
    }
    const extracted = extractTextAndLinks(res.html, res.finalUrl, officialHost);
    pages.push({ role: target.role, url: res.finalUrl, text: extracted.text });
  }

  return { pages, fetchErrors };
}
