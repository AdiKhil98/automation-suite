/**
 * Deterministic classification + scoring of a page's internal links into the page categories that
 * matter for decision-maker discovery. Pure functions only — no I/O, no model.
 *
 * Replaces the previous `TEAM_LINK_RE.test(`${absoluteUrl} ${anchorText}`)` first-match approach, which
 * failed on real sites in three ways this module fixes by construction:
 *   1. Substring matching across token boundaries: the branch `our-practice` matched INSIDE
 *      `sell-y|our-practice`, so a corporate M&A page won the team slot. Path matching here is
 *      token/segment based, so a keyword can never straddle a word boundary.
 *   2. URL and anchor text were concatenated into one haystack, making "matched the path" and "matched
 *      the link label" indistinguishable. They are scored separately here.
 *   3. First DOM match latched and won. On the standard dental IA (`About ▸ Team`, i.e. Team nested
 *      under About) that structurally picks the parent category page over the child roster. Candidates
 *      are ranked by score instead, so the more specific page wins regardless of document order.
 */

export type PageCategory = 'TEAM' | 'ABOUT_OWNERSHIP' | 'CONTACT' | 'IRRELEVANT';

export interface RawLink {
  href: string;
  anchorText: string;
  /** Lowercased attribute map of the anchor element (used only for menu-control detection). */
  attrs: Readonly<Record<string, string>>;
}

export interface LinkCandidate {
  category: Exclude<PageCategory, 'IRRELEVANT'>;
  score: number;
  /** Normalized absolute URL: fragment removed, tracking params stripped, trailing slash collapsed. */
  url: string;
  rawHref: string;
  anchorText: string;
  /** Fragment id when this link targets a section of the page it appears on; null otherwise. */
  sameDocumentFragment: string | null;
  reasons: string[];
}

/** Query params that never change which document is returned; stripped so `?utm_source=…` can't
 * defeat duplicate detection against the same page reached without campaign tags. */
const TRACKING_PARAM_RE = /^(utm_[a-z_]+|gclid|fbclid|msclkid|mc_cid|mc_eid|_ga|ref|source)$/i;

export interface NormalizedUrl {
  url: string;
  fragment: string | null;
}

/** Resolve `href` against `base` and normalize it for identity comparison. Returns null for hrefs that
 * are not resolvable http(s) URLs. The fragment is returned separately, never kept in `url`, so
 * `/page`, `/page#team` and `/page/?utm_source=x` all collapse to one identity. */
export function normalizeUrl(href: string, base: string): NormalizedUrl | null {
  let u: URL;
  try {
    u = new URL(href, base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const fragment = u.hash.length > 1 ? decodeURIComponent(u.hash.slice(1)) : null;
  u.hash = '';
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAM_RE.test(key)) u.searchParams.delete(key);
  }
  u.hostname = u.hostname.toLowerCase();
  if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
  return { url: u.toString(), fragment };
}

/** Collapse a label to comparable form: lowercase, punctuation to spaces, single-spaced. */
export function normalizePhrase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

interface PathParts {
  segments: string[];
  lastSegment: string;
  tokens: string[];
  /** All path tokens joined by spaces, e.g. `/sell-your-practice` -> "sell your practice". */
  phrase: string;
}

export function pathParts(normalizedUrl: string): PathParts {
  let pathname: string;
  try {
    pathname = new URL(normalizedUrl).pathname;
  } catch {
    pathname = '';
  }
  const segments = pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s).toLowerCase());
  const tokens = segments.flatMap((s) => s.split(/[-_.+]+/)).filter(Boolean);
  return { segments, lastSegment: segments[segments.length - 1] ?? '', tokens, phrase: tokens.join(' ') };
}

const TEAM_ANCHOR_PHRASES = [
  'meet the team', 'meet our team', 'meet the dentists', 'meet our dentists', 'meet your dentist',
  'meet your dentists', 'meet the practitioners', 'our team', 'the team', 'our dentists',
  'our clinicians', 'our staff', 'our people', 'dental team', 'clinical team', 'team',
];
const TEAM_SEGMENTS = new Set([
  'team', 'our-team', 'the-team', 'meet-the-team', 'meet-our-team', 'dental-team', 'clinical-team',
  'our-dentists', 'meet-the-dentists', 'staff', 'our-staff', 'people', 'our-people', 'clinicians',
  'our-clinicians', 'practitioners', 'meet-your-dentist',
]);
const TEAM_TOKENS = new Set(['team', 'staff', 'clinicians', 'practitioners']);

const ABOUT_ANCHOR_PHRASES = [
  'about us', 'about', 'our story', 'our history', 'our practice', 'who we are', 'practice history',
  'our journey', 'our founder', 'meet the owner', 'about the practice', 'about our practice',
];
const ABOUT_SEGMENTS = new Set([
  'about', 'about-us', 'aboutus', 'our-story', 'our-history', 'our-practice', 'who-we-are',
  'history', 'practice-history', 'our-journey', 'about-the-practice', 'about-our-practice',
]);
/** Weak ABOUT fallback: real About-equivalent on some sites (Dulwich has no /about at all), but it is
 * just as often a pure marketing page — scored below every strong signal and gated by post-fetch
 * content confirmation. */
const ABOUT_WEAK_ANCHOR_PHRASES = ['why choose us', 'why us', 'our values', 'our mission'];
const ABOUT_WEAK_SEGMENTS = new Set(['why-choose-us', 'why-us', 'our-values', 'our-mission']);

const CONTACT_ANCHOR_PHRASES = ['contact us', 'contact', 'get in touch', 'email us', 'enquiries'];
const CONTACT_SEGMENTS = new Set(['contact', 'contact-us', 'contactus', 'email-us', 'get-in-touch', 'enquiries']);

/** Vetoes TEAM/ABOUT classification outright. Every entry was observed as a real false positive or a
 * near miss in the 7-lead site survey (careers pages, M&A pages, referral funnels, SEO location pages,
 * fee/treatment pages, testimonial pages). */
const NEGATIVE_TOKENS = new Set([
  'career', 'careers', 'job', 'jobs', 'vacancy', 'vacancies', 'recruitment', 'recruiting', 'hiring',
  'sell', 'selling', 'buy', 'buying', 'acquire', 'acquisition', 'acquisitions', 'invest', 'investor',
  'investors', 'franchise', 'merger',
  'referral', 'referrals', 'refer',
  'blog', 'news', 'article', 'articles', 'press', 'testimonial', 'testimonials', 'review', 'reviews',
  'treatment', 'treatments', 'service', 'services', 'fee', 'fees', 'pricing', 'price', 'prices',
  'cost', 'costs', 'offer', 'offers', 'membership', 'plan', 'plans', 'finance',
  'find', 'directions', 'location', 'locations', 'map', 'parking',
  'privacy', 'terms', 'cookie', 'cookies', 'sitemap', 'complaint', 'complaints', 'policy', 'policies',
]);

/**
 * Reader-directed / transactional phrases. Deliberately phrase-level, not token-level: the single token
 * `your` is NOT a veto, because "meet your dentist" is a legitimate TEAM label. What marks a page as
 * being about the READER's business rather than the lead's is a transaction verb bound to a
 * second-person or first-person-plural object ("sell your practice", "join our team", "work for us").
 */
const TRANSACTIONAL_RES: readonly RegExp[] = [
  /\b(sell|selling|buy|buying|acquire|acquiring|value|valuing)\s+(your|my|a)\s+(practice|clinic|business|surgery)\b/,
  /\bpractice\s+(sales|acquisition|valuation)\b/,
  /\bjoin\s+(our|the)\s+(team|practice|family)\b/,
  /\bwork\s+(for|with)\s+us\b/,
  /\b(refer|referring)\s+(a|your|our)\s+(patient|patients|case)\b/,
  /\bapply\s+now\b/,
  /\bpartner\s+with\s+us\b/,
  /\bfor\s+dentists\b/,
  /\bhow\s+to\s+find\s+us\b/,
];

function matchesTransactional(...phrases: string[]): boolean {
  return phrases.some((p) => TRANSACTIONAL_RES.some((re) => re.test(p)));
}

function hasNegativeToken(tokens: readonly string[], anchorPhrase: string): boolean {
  if (tokens.some((t) => NEGATIVE_TOKENS.has(t))) return true;
  const anchorTokens = anchorPhrase.split(' ').filter(Boolean);
  return anchorTokens.some((t) => NEGATIVE_TOKENS.has(t));
}

/**
 * True for anchors that are navigation CONTROLS rather than destinations — a Bootstrap-style
 * `<a class="dropdown-toggle" href="#" role="button" data-bs-toggle="dropdown">About Us</a>` carries a
 * meaningful label but no destination, and previously won the team slot outright (its label matched, and
 * `#` resolved to the homepage, which was then fetched a second time).
 */
export function isMenuControl(link: RawLink): boolean {
  const href = link.href.trim();
  if (href === '' || href === '#') return true;
  if (/^(javascript|mailto|tel|sms|data):/i.test(href)) return true;
  const attrs = link.attrs;
  if ((attrs['role'] ?? '') === 'button') return true;
  if (attrs['aria-expanded'] !== undefined || attrs['aria-haspopup'] !== undefined) return true;
  if (Object.keys(attrs).some((k) => /^data-.*toggle$/.test(k))) return true;
  if (/\bdropdown-toggle\b/.test(attrs['class'] ?? '')) return true;
  return false;
}

interface CategoryScore {
  score: number;
  reasons: string[];
}

function scoreExactOrContains(
  anchorPhrase: string,
  phrases: readonly string[],
  exactPoints: number,
  containsPoints: number,
  label: string,
): CategoryScore {
  if (anchorPhrase.length === 0) return { score: 0, reasons: [] };
  if (phrases.includes(anchorPhrase)) return { score: exactPoints, reasons: [`anchor-exact:${label}:${anchorPhrase}`] };
  // Word-boundary containment: "our practices" (a chain's clinic list) must not match "our practice".
  const hit = phrases.find((p) => p.includes(' ') && new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(anchorPhrase));
  if (hit) return { score: containsPoints, reasons: [`anchor-contains:${label}:${hit}`] };
  return { score: 0, reasons: [] };
}

function scoreTeam(anchorPhrase: string, path: PathParts): CategoryScore {
  const anchor = scoreExactOrContains(anchorPhrase, TEAM_ANCHOR_PHRASES, 10, 6, 'team');
  let score = anchor.score;
  const reasons = [...anchor.reasons];
  if (TEAM_SEGMENTS.has(path.lastSegment)) {
    score += 8;
    reasons.push(`path-segment:team:${path.lastSegment}`);
  } else if (path.tokens.some((t) => TEAM_TOKENS.has(t))) {
    score += 5;
    reasons.push('path-token:team');
  }
  return { score, reasons };
}

function scoreAbout(anchorPhrase: string, path: PathParts): CategoryScore {
  const anchor = scoreExactOrContains(anchorPhrase, ABOUT_ANCHOR_PHRASES, 10, 6, 'about');
  let score = anchor.score;
  const reasons = [...anchor.reasons];
  if (ABOUT_SEGMENTS.has(path.lastSegment)) {
    score += 8;
    reasons.push(`path-segment:about:${path.lastSegment}`);
  } else if (path.tokens.includes('about')) {
    score += 5;
    reasons.push('path-token:about');
  }
  if (score === 0) {
    // Weak signals are worth 3 each so that even both together (6) stay strictly below the weakest
    // strong signal (8) — a "why choose us" page can never outrank a real About page.
    const weakAnchor = scoreExactOrContains(anchorPhrase, ABOUT_WEAK_ANCHOR_PHRASES, 3, 3, 'about-weak');
    score += weakAnchor.score;
    reasons.push(...weakAnchor.reasons);
    if (ABOUT_WEAK_SEGMENTS.has(path.lastSegment)) {
      score += 3;
      reasons.push(`path-segment:about-weak:${path.lastSegment}`);
    }
  }
  return { score, reasons };
}

function scoreContact(anchorPhrase: string, path: PathParts): CategoryScore {
  const anchor = scoreExactOrContains(anchorPhrase, CONTACT_ANCHOR_PHRASES, 10, 6, 'contact');
  let score = anchor.score;
  const reasons = [...anchor.reasons];
  if (CONTACT_SEGMENTS.has(path.lastSegment)) {
    score += 8;
    reasons.push(`path-segment:contact:${path.lastSegment}`);
  } else if (path.tokens.includes('contact')) {
    score += 5;
    reasons.push('path-token:contact');
  }
  return { score, reasons };
}

/** Minimum score for a link to be considered a usable candidate for its category. 4 admits the weak
 * ABOUT fallback (`why choose us`) as a last resort; every strong signal scores 8+. */
export const MIN_CANDIDATE_SCORE = 4;

/**
 * Classify one link. Returns null when the link is structurally unusable (menu control, unresolvable,
 * off-site) or scores below `MIN_CANDIDATE_SCORE` in every category.
 *
 * `currentPageUrl` must already be normalized; a link resolving to it with a fragment is reported via
 * `sameDocumentFragment` so the caller can extract that section from the DOM it already holds instead
 * of spending another HTTP request on the page it is standing on.
 */
export function classifyLink(
  link: RawLink,
  currentPageUrl: string,
  isSameSite: (url: string) => boolean,
): LinkCandidate | null {
  if (isMenuControl(link)) return null;
  const normalized = normalizeUrl(link.href, currentPageUrl);
  if (!normalized) return null;
  if (!isSameSite(normalized.url)) return null;

  const anchorPhrase = normalizePhrase(link.anchorText);
  const path = pathParts(normalized.url);
  const sameDocumentFragment = normalized.url === currentPageUrl ? normalized.fragment : null;

  if (matchesTransactional(anchorPhrase, path.phrase)) return null;

  const team = scoreTeam(anchorPhrase, path);
  const about = scoreAbout(anchorPhrase, path);
  const contact = scoreContact(anchorPhrase, path);

  const negative = hasNegativeToken(path.tokens, anchorPhrase);
  const teamScore = negative ? 0 : team.score;
  const aboutScore = negative ? 0 : about.score;

  const scored: Array<{ category: LinkCandidate['category']; s: CategoryScore; score: number }> = [
    { category: 'TEAM', s: team, score: teamScore },
    { category: 'ABOUT_OWNERSHIP', s: about, score: aboutScore },
    { category: 'CONTACT', s: contact, score: contact.score },
  ];
  const ranked = scored.sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best || best.score < MIN_CANDIDATE_SCORE) return null;

  return {
    category: best.category,
    score: best.score,
    url: normalized.url,
    rawHref: link.href,
    anchorText: link.anchorText,
    sameDocumentFragment,
    reasons: negative ? [...best.s.reasons, 'negative-token-veto-applied'] : best.s.reasons,
  };
}

export interface RankedCandidates {
  TEAM: LinkCandidate[];
  ABOUT_OWNERSHIP: LinkCandidate[];
  CONTACT: LinkCandidate[];
}

/**
 * Classify every link and return per-category candidates ranked by score (descending), de-duplicated by
 * normalized URL — the first (highest-scoring) occurrence of a URL wins, so a page linked once in a nav
 * and again in a footer is one candidate, not two.
 */
export function rankLinks(
  links: readonly RawLink[],
  currentPageUrl: string,
  isSameSite: (url: string) => boolean,
): RankedCandidates {
  const byCategory: RankedCandidates = { TEAM: [], ABOUT_OWNERSHIP: [], CONTACT: [] };
  for (const link of links) {
    const candidate = classifyLink(link, currentPageUrl, isSameSite);
    if (candidate) byCategory[candidate.category].push(candidate);
  }
  for (const key of Object.keys(byCategory) as Array<keyof RankedCandidates>) {
    const seen = new Map<string, LinkCandidate>();
    for (const c of byCategory[key].sort((a, b) => b.score - a.score)) {
      const existing = seen.get(c.url);
      // Prefer the same-document form of a URL: it is evidence we can extract without a fetch.
      if (!existing) seen.set(c.url, c);
      else if (!existing.sameDocumentFragment && c.sameDocumentFragment) seen.set(c.url, c);
    }
    byCategory[key] = [...seen.values()].sort((a, b) => b.score - a.score);
  }
  return byCategory;
}
