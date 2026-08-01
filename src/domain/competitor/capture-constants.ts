/**
 * Phase 7A2 competitor-evidence-capture constants. Deterministic bounds + taxonomy versions.
 *
 * Every value here is operator-approved and encoded in code (no hidden defaults). The rule version
 * is persisted on every captured evidence item so any historical outreach is reproducible against
 * the exact rules that produced it. Changing any weight/threshold/detector below REQUIRES bumping
 * COMPETITOR_EVIDENCE_RULES_VERSION.
 */

/** Bumped whenever any category detector, confidence rule, or bound below changes. Persisted. */
export const COMPETITOR_EVIDENCE_RULES_VERSION = 'comp-ev-1';

/** Bounded page policy (approved defaults; env may lower but never silently exceed these caps). */
export const DEFAULT_MAX_PAGES = 2; // plan-approved: <=2 public pages per competitor
export const DEFAULT_MAX_DEPTH = 1; // homepage + one same-origin hop
export const HARD_MAX_PAGES = 5; // absolute ceiling; env cannot exceed
export const HARD_MAX_DEPTH = 1; // absolute ceiling; env cannot exceed
export const DEFAULT_TIMEOUT_MS = 15_000; // per-navigation (mirrors CAPTURE_NAVIGATION_TIMEOUT_MS)
export const DEFAULT_TOTAL_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_REDIRECTS = 5;
export const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000;

/** Freshness: evidence is usable for outreach for 30 days after capture; older = STALE. */
export const DEFAULT_MAX_AGE_DAYS = 30;

/**
 * Approved public-page path candidates (same-origin only). Capture begins at the verified origin
 * and follows only these deterministic path shapes discovered from the homepage nav — never a
 * sitemap crawl, never search-engine crawling, never arbitrary URLs.
 */
export const CANDIDATE_PATH_MATCHERS: ReadonlyArray<{ role: CapturePageRole; test: RegExp }> = [
  { role: 'contact', test: /(contact|kontakt|contacto|contatto|reach-us|find-us)/i },
  { role: 'booking', test: /(book|booking|appointment|termin|buchen|reserve|reservation|rendez-vous)/i },
  { role: 'services', test: /(services|service|leistungen|treatments|behandlung|prestations)/i },
  { role: 'about', test: /(about|team|ueber-uns|über-uns|our-practice|praxis|a-propos|chi-siamo)/i },
  { role: 'faq', test: /(faq|questions|haeufige-fragen|häufige-fragen)/i },
  { role: 'location', test: /(location|standort|anfahrt|directions|where|find-us)/i },
];

export type CapturePageRole = 'homepage' | 'contact' | 'booking' | 'services' | 'about' | 'faq' | 'location';

/** Capture method recorded per run (fixture = offline HTML; live = real browser, guarded). */
export type CaptureMethod = 'FIXTURE' | 'LIVE_BROWSER';

/** Provider provenance recorded per run. */
export type CaptureProvider = 'fixture' | 'playwright';
