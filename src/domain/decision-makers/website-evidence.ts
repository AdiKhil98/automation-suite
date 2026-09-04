import * as cheerio from 'cheerio';
import { safeGetHtml, type FetchOutcome, type SafeGetOptions } from '../../utils/safe-fetch.js';
import {
  cleanPage,
  confirmsCategory,
  extractEvidence,
  fallbackSnippet,
  MAX_EVIDENCE_CHARS_PER_PAGE,
} from './evidence-extraction.js';
import { normalizeUrl, rankLinks, type LinkCandidate, type RawLink } from './link-classification.js';

/**
 * Bounded, SSRF-safe evidence gathering from ONE lead's own verified official website. Reuses
 * `safeGetHtml` (the same hardened GET used by the Phase-4 domain verifier) as-is for fetching; the
 * same-origin rule and every network protection are unchanged.
 *
 * Page selection is deterministic and scored (`link-classification.ts`), and page content is reduced to
 * targeted snippets rather than a leading character slice (`evidence-extraction.ts`).
 *
 * Budget: `maxPages` bounds BOTH the number of HTTP fetches and the number of evidence pages, so this
 * module can never issue more requests than the previous implementation. A team section that lives on
 * the page already in hand (`#practice-team`) is extracted from that DOM and costs no fetch at all.
 */

export type PageFetchFn = (url: string) => Promise<FetchOutcome>;

export function buildSafeHttpFetcher(opts: SafeGetOptions): PageFetchFn {
  return (url) => safeGetHtml(url, opts);
}

export type EvidenceRole = 'home' | 'team' | 'about' | 'contact';

export interface EvidencePage {
  role: EvidenceRole;
  url: string;
  text: string;
}

export interface GatherEvidenceResult {
  pages: EvidencePage[];
  fetchErrors: string[];
  /** HTTP GETs actually issued, including the homepage. Never exceeds `maxPages`. */
  fetchCount: number;
  /** Human-readable decision trail — surfaced by `--preview` so page choice is auditable without a run. */
  selection: string[];
}

/** At most two fetch attempts per category, so a category whose top candidate fails content
 * confirmation can fall through to its runner-up without burning the whole budget. */
const MAX_FETCH_ATTEMPTS_PER_CATEGORY = 2;

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

/** Collect every anchor with its attributes from the RAW document — link discovery must see the
 * navigation that `cleanPage` strips for text extraction. */
function collectRawLinks(html: string): RawLink[] {
  const $ = cheerio.load(html);
  $('script, style, template').remove();
  const links: RawLink[] = [];
  $('a[href]').each((_, el) => {
    const attrs = $(el).attr() ?? {};
    const href = attrs['href'] ?? '';
    const lowered: Record<string, string> = {};
    for (const [k, v] of Object.entries(attrs)) lowered[k.toLowerCase()] = v;
    links.push({ href, anchorText: $(el).text().replace(/\s+/g, ' ').trim(), attrs: lowered });
  });
  return links;
}

function assembleText(snippets: string[], cleanedText: string): string {
  const chosen = snippets.length > 0 ? snippets : fallbackSnippet(cleanedText);
  return chosen.join(' … ').slice(0, MAX_EVIDENCE_CHARS_PER_PAGE);
}

export async function gatherWebsiteEvidence(fetch: PageFetchFn, baseUrl: string, maxPages: number): Promise<GatherEvidenceResult> {
  const officialHost = hostOf(baseUrl);
  const fetchErrors: string[] = [];
  const selection: string[] = [];
  if (!officialHost) {
    return { pages: [], fetchErrors: [`invalid official website URL: ${baseUrl}`], fetchCount: 0, selection };
  }
  const isSameSite = (url: string): boolean => isSameOfficialSite(hostOf(url), officialHost);

  const home = await fetch(baseUrl);
  let fetchCount = 1;
  if (home.kind !== 'ok') {
    fetchErrors.push(`homepage fetch ${home.kind}: ${home.reason}`);
    return { pages: [], fetchErrors, fetchCount, selection };
  }

  const homeNormalized = normalizeUrl(home.finalUrl, home.finalUrl)?.url ?? home.finalUrl;
  const homeClean = cleanPage(home.html);
  const homeEvidence = extractEvidence(homeClean.text);
  const pages: EvidencePage[] = [
    { role: 'home', url: home.finalUrl, text: assembleText(homeEvidence.snippets, homeClean.text) },
  ];
  selection.push(`home: ${home.finalUrl} (${String(homeEvidence.snippets.length)} targeted snippets)`);

  const ranked = rankLinks(collectRawLinks(home.html), homeNormalized, isSameSite);
  const visited = new Set<string>([homeNormalized]);

  const budgetLeft = (): boolean => fetchCount < maxPages && pages.length < maxPages;

  /** Use a section of the page already fetched — zero additional HTTP requests. */
  const trySameDocumentSection = (candidates: readonly LinkCandidate[], role: 'team' | 'about', category: 'TEAM' | 'ABOUT_OWNERSHIP'): boolean => {
    if (pages.length >= maxPages) return false;
    const candidate = candidates.find((c) => c.sameDocumentFragment !== null);
    if (!candidate?.sameDocumentFragment) return false;
    const { sectionText } = cleanPage(home.html, candidate.sameDocumentFragment);
    if (!sectionText) return false;
    const evidence = extractEvidence(sectionText);
    if (!confirmsCategory(evidence.signals, category)) {
      selection.push(`${role}: in-page section #${candidate.sameDocumentFragment} not confirmed by content`);
      return false;
    }
    pages.push({
      role,
      url: `${homeNormalized}#${candidate.sameDocumentFragment}`,
      text: assembleText(evidence.snippets, sectionText),
    });
    selection.push(`${role}: in-page section #${candidate.sameDocumentFragment} of the homepage (no extra fetch, score ${String(candidate.score)})`);
    return true;
  };

  const tryFetchCategory = async (candidates: readonly LinkCandidate[], role: 'team' | 'about' | 'contact', category: 'TEAM' | 'ABOUT_OWNERSHIP' | null): Promise<boolean> => {
    let attempts = 0;
    for (const candidate of candidates) {
      if (attempts >= MAX_FETCH_ATTEMPTS_PER_CATEGORY || !budgetLeft()) break;
      if (candidate.sameDocumentFragment !== null) continue; // never spend a request on the current page
      if (visited.has(candidate.url)) continue;
      visited.add(candidate.url);
      attempts += 1;
      fetchCount += 1;
      const res = await fetch(candidate.url);
      if (res.kind !== 'ok') {
        fetchErrors.push(`${role} page fetch ${res.kind}: ${res.reason}`);
        continue;
      }
      const clean = cleanPage(res.html);
      const evidence = extractEvidence(clean.text);
      if (category && !confirmsCategory(evidence.signals, category)) {
        selection.push(`${role}: rejected ${candidate.url} (score ${String(candidate.score)}) — content confirmation failed`);
        continue;
      }
      pages.push({ role, url: res.finalUrl, text: assembleText(evidence.snippets, clean.text) });
      selection.push(`${role}: ${res.finalUrl} (score ${String(candidate.score)}, ${candidate.reasons.join('+')})`);
      return true;
    }
    return false;
  };

  const teamResolved =
    trySameDocumentSection(ranked.TEAM, 'team', 'TEAM') || (await tryFetchCategory(ranked.TEAM, 'team', 'TEAM'));
  const aboutResolved =
    trySameDocumentSection(ranked.ABOUT_OWNERSHIP, 'about', 'ABOUT_OWNERSHIP') ||
    (await tryFetchCategory(ranked.ABOUT_OWNERSHIP, 'about', 'ABOUT_OWNERSHIP'));

  // Contact is a low-priority fallback only: across the seven real leads surveyed it contributed no
  // decision-maker evidence on any of them, and contact-email discovery is owned by contact-resolve-batch.
  if (!teamResolved && !aboutResolved && budgetLeft()) {
    await tryFetchCategory(ranked.CONTACT, 'contact', null);
  }

  return { pages, fetchErrors, fetchCount, selection };
}
