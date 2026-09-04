import * as cheerio from 'cheerio';

/**
 * Targeted evidence extraction: turn a fetched page into a small number of high-signal snippets
 * centred on the text that actually identifies a decision-maker, plus a deterministic content
 * confirmation that the page is what its link claimed to be.
 *
 * Replaces "send the first 1500 characters of `$('body').text()`". On the real sites surveyed, that
 * window was consumed by navigation boilerplate (up to ~1130 chars on one site, whose menu is emitted
 * twice) and the decision-maker evidence sat at offsets 1612-2549 — fetched, stored, and then thrown
 * away before the model ever saw it. Raising the constant would not fix that: the useful text is not at
 * the start of the page, so this module locates it instead.
 */

/** Structural boilerplate: chrome that repeats on every page of a site and never carries the evidence.
 * `header` is deliberately NOT removed wholesale — many sites wrap the page's own <h1> in it. */
const BOILERPLATE_SELECTORS = [
  'script', 'style', 'noscript', 'template', 'svg', 'iframe',
  'nav', 'footer', 'form',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[role="search"]',
  '[class*="cookie" i]', '[id*="cookie" i]',
  '[class*="breadcrumb" i]', '[class*="navbar" i]', '[class*="nav-menu" i]', '[class*="menu-toggle" i]',
  '[class*="skip-link" i]', '[class*="sidebar" i]', '[class*="site-footer" i]', '[class*="social" i]',
  // Review/testimonial containers: their author names are patients, not staff. One surveyed site
  // publishes seven schema.org Person objects that are all Review.author.
  '[class*="testimonial" i]', '[id*="testimonial" i]', '[class*="review" i]', '[id*="reviews" i]',
].join(', ');

export interface CleanedPage {
  /** Whitespace-normalized visible text with structural boilerplate removed. */
  text: string;
  /** Text of a specific in-page section, when one was requested and found. */
  sectionText: string | null;
}

const MAX_SECTION_CHARS = 3000;

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Parse HTML once and return the de-boilerplated page text, plus the text of `fragmentId`'s section
 * when supplied. The section lookup runs BEFORE boilerplate removal is applied to the section itself so
 * that a section living inside a stripped container is still recoverable.
 */
/** Below this, boilerplate removal is assumed to have eaten the content itself and the minimally-cleaned
 * text is used instead. Not hypothetical: one surveyed practice page nests its entire body inside
 * navigation containers, and strips to zero characters while carrying 11k characters of real content.
 * Measured against the surveyed cohort, genuine content pages strip to 432-5407 chars, so this floor
 * only ever catches the degenerate case. */
const MIN_USEFUL_TEXT_CHARS = 200;

export function cleanPage(html: string, fragmentId?: string | null): CleanedPage {
  const $ = cheerio.load(html);
  $('script, style, noscript, template').remove();
  const minimallyCleaned = collapse($('body').text());

  let sectionText: string | null = null;
  if (fragmentId) {
    const escaped = fragmentId.replace(/["\\]/g, '\\$&');
    let el = $(`#${CSS_escape(fragmentId)}`).first();
    if (el.length === 0) el = $(`[name="${escaped}"]`).first();
    if (el.length > 0) {
      // An anchor target is often an empty <a id> or a bare heading; climb to the container that
      // actually holds the section's content.
      let node = el;
      for (let i = 0; i < 4 && collapse(node.text()).length < 200; i += 1) {
        const parent = node.parent();
        if (parent.length === 0 || parent.is('body, html')) break;
        node = parent;
      }
      const text = collapse(node.text());
      if (text.length > 0) sectionText = text.slice(0, MAX_SECTION_CHARS);
    }
  }

  $(BOILERPLATE_SELECTORS).remove();
  const stripped = collapse($('body').text());
  return { text: stripped.length >= MIN_USEFUL_TEXT_CHARS ? stripped : minimallyCleaned, sectionText };
}

/** Minimal CSS.escape for id selectors (Node has no DOM CSS object). */
function CSS_escape(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

const HONORIFIC_NAME_RE = /\b(?:Dr|Mr|Mrs|Ms|Miss|Prof)\.?\s+[A-Z][A-Za-z'’-]{1,24}(?:\s+[A-Z][A-Za-z'’-]{1,24})?/g;
const PLAIN_NAME_RE = /\b[A-Z][a-z'’-]{1,20}\s+[A-Z][A-Za-z'’-]{1,24}\b/g;

/** Words that form capitalized two-word pairs but are never a person's name. Without this, the
 * complaints-procedure sentence "please write to the Practice Manager or the Clinical Director"
 * reads as two people. */
const NON_NAME_WORDS = new Set([
  'practice', 'manager', 'director', 'clinical', 'dental', 'team', 'meet', 'our', 'the', 'contact',
  'book', 'read', 'more', 'find', 'view', 'full', 'profile', 'load', 'show', 'next', 'steps', 'about',
  'home', 'dentist', 'dentists', 'hygienist', 'hygienists', 'nurse', 'nurses', 'reception',
  'receptionist', 'therapist', 'orthodontist', 'surgeon', 'associate', 'principal', 'owner', 'founder',
  'partner', 'staff', 'people', 'clinicians', 'gdc', 'no', 'number', 'level', 'diploma', 'certificate',
  'new', 'patients', 'patient', 'general', 'care', 'treatment', 'treatments', 'smile', 'appointment',
  'appointments', 'opening', 'hours', 'why', 'choose', 'welcome', 'call', 'email', 'phone', 'monday',
  'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march',
  'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  // Corporate-entity words: a chain's About page states "Our majority owner is Jacobs Holding AG",
  // which is ownership of the GROUP by a company — not a person who runs this practice.
  'holding', 'holdings', 'capital', 'group', 'ag', 'plc', 'ltd', 'llc', 'llp', 'gmbh', 'inc',
  'limited', 'partners', 'investments', 'investment', 'corporation', 'corp', 'company', 'dental',
]);

interface Match {
  value: string;
  index: number;
}

function matchAll(text: string, re: RegExp): Match[] {
  const out: Match[] = [];
  const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text)) !== null) {
    out.push({ value: m[0], index: m.index });
    if (m.index === rx.lastIndex) rx.lastIndex += 1;
  }
  return out;
}

function isPlausibleName(candidate: string): boolean {
  const words = candidate.replace(/\b(?:Dr|Mr|Mrs|Ms|Miss|Prof)\.?\s+/g, '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  return words.every((w) => !NON_NAME_WORDS.has(w.toLowerCase().replace(/[^a-z'’-]/g, '')));
}

export function findPersonNames(text: string): Match[] {
  const honorific = matchAll(text, HONORIFIC_NAME_RE);
  const plain = matchAll(text, PLAIN_NAME_RE).filter((m) => isPlausibleName(m.value));
  const merged = [...honorific, ...plain].sort((a, b) => a.index - b.index);
  const out: Match[] = [];
  for (const m of merged) {
    const last = out[out.length - 1];
    if (last && m.index < last.index + last.value.length) continue; // overlapping form of the same name
    out.push(m);
  }
  return out;
}

/** Titles that make someone a decision-maker. Mirrors title-priority.ts's tiers (which remains the
 * single authority on acceptance); used here only to decide whether a page is worth keeping. */
const DECISION_ROLE_RE = /\b(owner|co-?founder|founder|principal dentist|practice principal|principal|clinical director|dental director|managing director|practice manager|partner)\b/gi;
/** Roster roles — evidence that a page is a genuine team listing even when nobody on it qualifies. */
const CLINICAL_ROLE_RE = /\b(dentist|dental surgeon|orthodontist|periodontist|endodontist|prosthodontist|implant surgeon|hygienist|dental nurse|dental therapist|therapist|treatment coordinator|receptionist|associate|practice manager)\b/gi;
const GDC_RE = /\bGDC\b[^0-9]{0,25}\d{5,6}/gi;

/** Ownership/authority expressed as a relationship in prose. On two of the seven surveyed leads this is
 * the ONLY place the actual owner is identified — their team page gives them a purely clinical title
 * ("Specialist Prosthodontist", "Dentist") that the deterministic gate rejects. */
const OWNERSHIP_RE = /\b(owned and operated by|owned and run by|owned by|founded by|co-founded by|was founded|established by|was established|opened by|was opened|took ownership|takes ownership|take ownership|entered into (?:a )?partnership|acquired by|took over|bought the practice|set up the practice|started the practice)\b/gi;
/** Reader-directed ownership language ("As the owner of your practice, the decision to sell…") is about
 * the visitor's business, not the lead's. */
const READER_DIRECTED_RE = /\b(your|my)\s+(practice|clinic|business|surgery)\b/i;

const WINDOW_BEFORE = 220;
const WINDOW_AFTER = 320;
const MAX_SNIPPETS = 6;
export const MAX_EVIDENCE_CHARS_PER_PAGE = 2200;

interface Window {
  start: number;
  end: number;
}

function windowAround(text: string, index: number, length: number): Window {
  const start = Math.max(0, index - WINDOW_BEFORE);
  const end = Math.min(text.length, index + length + WINDOW_AFTER);
  return { start, end };
}

function mergeWindows(windows: Window[]): Window[] {
  const sorted = [...windows].sort((a, b) => a.start - b.start);
  const out: Window[] = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && w.start <= last.end + 40) last.end = Math.max(last.end, w.end);
    else out.push({ ...w });
  }
  return out;
}

/** Nearest name within `maxDistance` characters of `index`, in either direction. */
function nameNear(names: readonly Match[], index: number, maxDistance: number): Match | null {
  let best: Match | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const n of names) {
    const distance = n.index <= index ? index - (n.index + n.value.length) : n.index - index;
    if (distance <= maxDistance && distance < bestDistance) {
      best = n;
      bestDistance = distance;
    }
  }
  return best;
}

export interface ContentSignals {
  personNames: number;
  namesNearDecisionRole: number;
  namesNearClinicalRole: number;
  gdcNumbers: number;
  namedOwnershipStatements: number;
}

export interface ExtractedEvidence {
  /** Targeted, boilerplate-free excerpts, in document order. Empty when nothing matched. */
  snippets: string[];
  signals: ContentSignals;
}

const NAME_ROLE_MAX_DISTANCE = 80;
const NAME_OWNERSHIP_MAX_DISTANCE = 150;

/**
 * Locate the decision-maker-bearing regions of `text` and return them as merged, capped snippets,
 * together with the deterministic signals used for content confirmation.
 */
export function extractEvidence(text: string): ExtractedEvidence {
  const names = findPersonNames(text);
  const decisionRoles = matchAll(text, DECISION_ROLE_RE);
  const clinicalRoles = matchAll(text, CLINICAL_ROLE_RE);
  const gdc = matchAll(text, GDC_RE);
  const ownership = matchAll(text, OWNERSHIP_RE);

  const windows: Window[] = [];
  let namesNearDecisionRole = 0;
  let namesNearClinicalRole = 0;
  let namedOwnershipStatements = 0;

  for (const role of decisionRoles) {
    if (nameNear(names, role.index, NAME_ROLE_MAX_DISTANCE)) {
      namesNearDecisionRole += 1;
      windows.push(windowAround(text, role.index, role.value.length));
    }
  }
  for (const role of clinicalRoles) {
    if (nameNear(names, role.index, NAME_ROLE_MAX_DISTANCE)) {
      namesNearClinicalRole += 1;
      windows.push(windowAround(text, role.index, role.value.length));
    }
  }
  for (const own of ownership) {
    const window = windowAround(text, own.index, own.value.length);
    const context = text.slice(window.start, window.end);
    if (READER_DIRECTED_RE.test(context)) continue; // about the reader's practice, not this lead's
    if (!nameNear(names, own.index, NAME_OWNERSHIP_MAX_DISTANCE)) continue;
    namedOwnershipStatements += 1;
    windows.push(window);
  }
  for (const g of gdc) {
    windows.push(windowAround(text, g.index, g.value.length));
  }

  const merged = mergeWindows(windows).slice(0, MAX_SNIPPETS);
  const snippets: string[] = [];
  let used = 0;
  for (const w of merged) {
    if (used >= MAX_EVIDENCE_CHARS_PER_PAGE) break;
    const snippet = text.slice(w.start, Math.min(w.end, w.start + (MAX_EVIDENCE_CHARS_PER_PAGE - used))).trim();
    if (snippet.length === 0) continue;
    snippets.push(snippet);
    used += snippet.length;
  }

  return {
    snippets,
    signals: {
      personNames: names.length,
      namesNearDecisionRole,
      namesNearClinicalRole,
      gdcNumbers: gdc.length,
      namedOwnershipStatements,
    },
  };
}

export type ConfirmCategory = 'TEAM' | 'ABOUT_OWNERSHIP';

/**
 * Does the fetched content actually support the category its link promised? A high link score only
 * makes a page likely; this is what stops a fee page under `/about-us/`, a corporate brand page, or a
 * complaints procedure that merely names roles ("please write to the Practice Manager or the Clinical
 * Director") from occupying an evidence slot.
 */
export function confirmsCategory(signals: ContentSignals, category: ConfirmCategory): boolean {
  if (category === 'TEAM') {
    if (signals.namesNearDecisionRole >= 1) return true;
    if (signals.namesNearClinicalRole >= 2) return true;
    if (signals.gdcNumbers >= 2) return true;
    return signals.namesNearClinicalRole >= 1 && signals.gdcNumbers >= 1;
  }
  return signals.namedOwnershipStatements >= 1 || signals.namesNearDecisionRole >= 1;
}

/** Fallback when a page yields no targeted snippet: a bounded slice of the cleaned (boilerplate-free)
 * text, so an evidence page is never empty. */
export function fallbackSnippet(text: string): string[] {
  const slice = text.slice(0, MAX_EVIDENCE_CHARS_PER_PAGE).trim();
  return slice.length > 0 ? [slice] : [];
}
