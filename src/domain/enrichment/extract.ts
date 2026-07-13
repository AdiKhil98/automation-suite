import * as cheerio from 'cheerio';
import { type ExtractedPage, type StructuredBusiness } from './types.js';

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const CONTACT_PATH_RE = /(contact|about|location|find-us|branches|our-practice)/i;

/**
 * Deterministic, non-browser HTML extraction with cheerio. Pulls only publicly
 * displayed signals — tel:/mailto:, visible emails/phones, contact links, JSON-LD
 * business data, and shell-detection markers. No raw HTML is retained.
 */
export function extractPage(
  html: string,
  requestedUrl: string,
  finalUrl: string,
  httpStatus: number,
): ExtractedPage {
  const $ = cheerio.load(html);
  const host = safeHost(finalUrl);

  $('script, style, noscript, template').remove();
  const visibleText = $('body').text().replace(/\s+/g, ' ').trim();

  const emails = new Set<string>();
  const phones = new Set<string>();
  const contactFormUrls = new Set<string>();
  const sameOriginLinks: Array<{ href: string; text: string }> = [];

  const reloaded = cheerio.load(html); // second load retaining scripts for detection
  const scriptCount = reloaded('script').length;

  reloaded('a[href^="mailto:"]').each((_, el) => {
    const href = reloaded(el).attr('href') ?? '';
    const addr = href.replace(/^mailto:/i, '').split('?')[0]?.trim();
    if (addr && EMAIL_RE.test(addr)) emails.add(addr.toLowerCase());
    EMAIL_RE.lastIndex = 0;
  });
  for (const m of visibleText.matchAll(EMAIL_RE)) emails.add(m[0].toLowerCase());

  reloaded('a[href^="tel:"]').each((_, el) => {
    const href = reloaded(el).attr('href') ?? '';
    const num = href.replace(/^tel:/i, '').trim();
    if (num) phones.add(num);
  });

  reloaded('a[href]').each((_, el) => {
    const href = reloaded(el).attr('href') ?? '';
    const text = reloaded(el).text().replace(/\s+/g, ' ').trim();
    const abs = absolute(href, finalUrl);
    if (!abs) return;
    if (safeHost(abs) === host) {
      if (CONTACT_PATH_RE.test(abs) || CONTACT_PATH_RE.test(text)) {
        sameOriginLinks.push({ href: abs, text });
      }
    }
  });
  reloaded('form').each((_, el) => {
    const action = reloaded(el).attr('action') ?? '';
    const abs = absolute(action || finalUrl, finalUrl);
    if (abs && (CONTACT_PATH_RE.test(abs) || reloaded(el).find(':contains("message")').length > 0)) {
      contactFormUrls.add(abs);
    }
  });

  const structured = extractJsonLd(reloaded);
  const legalText = extractLegal($);
  const hasEmptyAppRoot = detectEmptyAppRoot(reloaded);

  return {
    requestedUrl,
    finalUrl,
    host: host ?? '',
    httpStatus,
    title: $('title').first().text().trim() || null,
    visibleTextLength: visibleText.length,
    visibleTextSample: visibleText.slice(0, 5000).toLowerCase(),
    scriptCount,
    hasEmptyAppRoot,
    phones: [...phones],
    emails: [...emails],
    contactFormUrls: [...contactFormUrls],
    structured,
    sameOriginLinks,
    legalText,
  };
}

function extractJsonLd(reloaded: cheerio.CheerioAPI): StructuredBusiness[] {
  const out: StructuredBusiness[] = [];
  reloaded('script[type="application/ld+json"]').each((_, el) => {
    const raw = reloaded(el).text();
    if (!raw) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      for (const node of Array.isArray(parsed) ? parsed : [parsed]) collectBusiness(node, out);
    } catch {
      /* ignore malformed JSON-LD */
    }
  });
  return out;
}

function collectBusiness(node: unknown, out: StructuredBusiness[]): void {
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  const graph = obj['@graph'];
  if (Array.isArray(graph)) for (const g of graph) collectBusiness(g, out);
  const type = obj['@type'];
  const typeStr = Array.isArray(type) ? type.join(',') : typeof type === 'string' ? type : '';
  if (/LocalBusiness|Organization|Dentist|MedicalBusiness|Store/i.test(typeStr)) {
    const address = obj.address as Record<string, unknown> | undefined;
    out.push({
      type: typeStr,
      name: typeof obj.name === 'string' ? obj.name : undefined,
      telephone: typeof obj.telephone === 'string' ? obj.telephone : undefined,
      streetAddress: typeof address?.streetAddress === 'string' ? address.streetAddress : undefined,
      addressLocality:
        typeof address?.addressLocality === 'string' ? address.addressLocality : undefined,
    });
  }
}

function extractLegal($: cheerio.CheerioAPI): string | null {
  const footer = $('footer').first().text().replace(/\s+/g, ' ').trim();
  const match = /((?:[A-Z][\w&'-]+\s+){1,6}(?:Ltd|Limited|LLP|Inc|PLC|GmbH))\b/.exec(footer);
  return match?.[1] ?? null;
}

function detectEmptyAppRoot(reloaded: cheerio.CheerioAPI): boolean {
  for (const sel of ['#root', '#app', '#__next', '[ng-app]', '[data-reactroot]']) {
    const el = reloaded(sel).first();
    if (el.length > 0 && el.text().trim().length < 20) return true;
  }
  return false;
}

function absolute(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}
