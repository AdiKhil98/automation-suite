import * as cheerio from 'cheerio';
import { hashCanonical, sha256Hex } from '../../utils/hash.js';
import { type RenderedPage } from './capture-types.js';

export const CAPTURE_EXTRACTOR_VERSION = 'cap-extract-1';

export const CAPTURE_EVIDENCE_TYPES = [
  'title',
  'meta_description',
  'lang',
  'canonical',
  'heading',
  'nav_label',
  'cta',
  'link',
  'mailto',
  'tel',
  'form',
  'image_alt',
  'structured_data',
  'footer_legal',
  'horizontal_overflow',
] as const;
export type CaptureEvidenceType = (typeof CAPTURE_EVIDENCE_TYPES)[number];

export interface CaptureEvidenceItem {
  evidenceType: CaptureEvidenceType;
  sourceUrl: string;
  profile: 'desktop' | 'mobile';
  selector: string | null;
  extractedValue: string;
  normalizedValue: string | null;
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * Deterministic, non-subjective evidence from a rendered page. Records observations
 * only (e.g. horizontal_overflow=true) — never quality judgements (Phase 6's job).
 */
export function extractCaptureEvidence(page: RenderedPage): CaptureEvidenceItem[] {
  const $ = cheerio.load(page.html);
  const items: CaptureEvidenceItem[] = [];
  const url = page.finalUrl;
  const add = (
    evidenceType: CaptureEvidenceType,
    value: string,
    selector: string | null,
    normalized?: string | null,
  ): void => {
    const v = norm(value);
    if (!v) return;
    items.push({ evidenceType, sourceUrl: url, profile: page.profile, selector, extractedValue: v.slice(0, 2000), normalizedValue: normalized === undefined ? v.toLowerCase().slice(0, 2000) : normalized });
  };

  const title = $('title').first().text();
  if (title) add('title', title, 'title');
  const meta = $('meta[name="description"]').attr('content');
  if (meta) add('meta_description', meta, 'meta[name=description]');
  const lang = $('html').attr('lang');
  if (lang) add('lang', lang, 'html[lang]');
  const canonical = $('link[rel="canonical"]').attr('href');
  if (canonical) add('canonical', canonical, 'link[rel=canonical]', null);

  $('h1, h2, h3').slice(0, 20).each((_, el) => add('heading', $(el).text(), el.tagName));
  $('nav a').slice(0, 30).each((_, el) => add('nav_label', $(el).text(), 'nav a'));
  $('button, a.button, .btn, [role="button"]').slice(0, 20).each((_, el) => add('cta', $(el).text(), 'cta'));

  const links = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    if (href.startsWith('mailto:')) add('mailto', href.replace(/^mailto:/i, ''), 'a[mailto]', href.replace(/^mailto:/i, '').toLowerCase());
    else if (href.startsWith('tel:')) add('tel', href.replace(/^tel:/i, ''), 'a[tel]', null);
    else if (/^https?:/i.test(href)) links.add(href);
  });
  for (const href of [...links].slice(0, 50)) {
    let host: string | null;
    try {
      host = new URL(href).host.toLowerCase();
    } catch {
      host = null;
    }
    add('link', href, 'a[href]', host);
  }

  $('form').slice(0, 10).each((_, el) => {
    const action = $(el).attr('action') ?? '';
    const labels = $(el).find('label').map((_i, l) => norm($(l).text())).get().join('|');
    add('form', `action=${action} labels=${labels}`, 'form', null);
  });
  $('img[alt]').slice(0, 30).each((_, el) => {
    const alt = $(el).attr('alt') ?? '';
    if (alt.trim()) add('image_alt', alt, 'img[alt]');
  });
  $('script[type="application/ld+json"]').slice(0, 10).each((_, el) => add('structured_data', $(el).text().slice(0, 1000), 'ld+json', null));
  const footer = $('footer').first().text();
  if (footer) add('footer_legal', footer.slice(0, 500), 'footer');

  if (page.hasHorizontalOverflow) {
    add('horizontal_overflow', 'true', null, 'true');
  }

  return items;
}

export function rawDomHash(html: string): string {
  return sha256Hex(html);
}

export function screenshotHash(bytes: Buffer): string {
  return sha256Hex(bytes.toString('base64'));
}

/**
 * Semantic fingerprint from deterministic evidence, EXCLUDING volatile values
 * (timestamps, random ids, nonces, session/tracking params). Used for
 * unchanged-page detection across runs.
 */
export function normalizedEvidenceFingerprint(items: CaptureEvidenceItem[]): string {
  const stable = items
    .filter((i) => i.evidenceType !== 'structured_data') // may embed nonces/timestamps
    .map((i) => ({
      t: i.evidenceType,
      p: i.profile,
      v: stripVolatile(i.normalizedValue ?? i.extractedValue),
    }))
    .sort((a, b) => (a.t + a.p + a.v < b.t + b.p + b.v ? -1 : 1));
  return hashCanonical(stable);
}

function stripVolatile(value: string): string {
  return value
    .replace(/nonce-[a-z0-9+/=]+/gi, 'nonce')
    .replace(/\b[0-9a-f]{16,}\b/gi, 'hex')
    .replace(/\b\d{10,13}\b/g, 'ts')
    .replace(/([?&])(utm_[^=]+|fbclid|gclid|sid|sessionid)=[^&#]*/gi, '$1$2=')
    .trim();
}
