import * as cheerio from 'cheerio';
import { type CheerioAPI } from 'cheerio';
import {
  type CapturedPageInput,
  type EvidenceCategory,
  type EvidenceConfidence,
  type EvidenceObservation,
  type ObservationKind,
  type WithholdingReason,
} from './evidence-types.js';

/**
 * Phase 7A2 deterministic evidence detectors. Each category has an explicit, reproducible rule over
 * a rendered page's DOM (cheerio) — NO AI, NO subjectivity, NO performance/volume/ranking inference.
 *
 * Detectors return presence/absence facts and structural interpretations only. `null` means "no
 * reproducible observation" (absence is not asserted as negative evidence). Every returned excerpt is
 * whitespace-normalized and length-bounded; every selector is a stable, reproducible locator.
 */

const MAX_EXCERPT = 160;

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
const clip = (s: string): string => norm(s).slice(0, MAX_EXCERPT);

interface DetectorHit {
  kind: ObservationKind;
  observation: string;
  selector: string | null;
  excerpt: string | null;
  confidence: EvidenceConfidence;
  numericValue?: number | null;
  withholdingReason?: WithholdingReason | null;
}

const BOOKING_RE = /\b(book|booking|appointment|termin|buchen|reserve|reservation|rendez-?vous|schedule a visit)\b/i;
const SERVICES_RE = /\b(services?|leistungen|treatments?|behandlung(en)?|prestations|servizi)\b/i;
const ABOUT_TEAM_RE = /\b(our team|meet the team|unser team|the team|our (doctors|dentists|practitioners|staff)|about us|über uns|ueber uns)\b/i;
const TESTIMONIAL_RE = /\b(testimonials?|reviews?|what our (patients|clients|customers)|bewertungen|erfahrungsberichte|kundenstimmen)\b/i;
const PRICING_RE = /\b(pricing|prices?|preise|kosten|financing|finanzierung|payment plans?|fees?)\b/i;
const EMERGENCY_RE = /\b(emergency|urgent|notfall|24\s*\/\s*7|out[- ]of[- ]hours|same[- ]day)\b/i;
// No \b anchors: ASCII word boundaries don't sit against non-ASCII letters (e.g. ö), which would
// otherwise cause umlaut phrases to silently miss.
const HOURS_RE = /(opening hours|öffnungszeiten|oeffnungszeiten|business hours|hours of operation|sprechzeiten|our hours)/i;
const FAQ_RE = /\b(faq|frequently asked questions|häufige fragen|haeufige fragen|questions fréquentes)\b/i;
const CONTACT_RE = /\b(contact|kontakt|contacto|contatto)\b/i;
const WHATSAPP_HOST_RE = /(wa\.me|api\.whatsapp\.com|web\.whatsapp\.com|whatsapp\.com|m\.me|messenger\.com)/i;

function headingOrNav($: CheerioAPI, re: RegExp): { el: string; text: string; structured: boolean } | null {
  let found: { el: string; text: string; structured: boolean } | null = null;
  $('h1, h2, h3').each((_, el) => {
    if (found) return;
    const text = norm($(el).text());
    if (text && re.test(text)) found = { el: el.tagName, text, structured: true };
  });
  if (found) return found;
  $('nav a, a').each((_, el) => {
    if (found) return;
    const text = norm($(el).text());
    if (text && re.test(text)) found = { el: 'a', text, structured: false };
  });
  return found;
}

function detectBookingCta($: CheerioAPI): DetectorHit | null {
  let hit: DetectorHit | null = null;
  $('a[href], button, [role="button"], .btn, a.button').each((_, el) => {
    if (hit) return;
    const $el = $(el);
    const text = norm($el.text());
    const href = $el.attr('href') ?? '';
    const inText = BOOKING_RE.test(text);
    const inHref = BOOKING_RE.test(href);
    if (!inText && !inHref) return;
    const isAnchor = el.tagName === 'a' && Boolean(href);
    hit = {
      kind: 'DIRECT_OBSERVATION',
      observation: 'A booking/appointment call-to-action is present on the page.',
      selector: isAnchor ? 'a[href]' : el.tagName,
      excerpt: clip(text || href),
      // Structured anchor with a booking href is stable → HIGH; button/text-only → MEDIUM.
      confidence: isAnchor && inHref ? 'HIGH' : 'MEDIUM',
    };
  });
  return hit;
}

function detectPhone($: CheerioAPI): DetectorHit | null {
  const tel = $('a[href^="tel:"]').first();
  if (tel.length > 0) {
    return {
      kind: 'DIRECT_OBSERVATION',
      observation: 'A click-to-call phone control (tel: link) is present.',
      selector: 'a[href^=tel:]',
      excerpt: clip((tel.attr('href') ?? '').replace(/^tel:/i, '')),
      confidence: 'HIGH',
    };
  }
  return null;
}

function detectWhatsApp($: CheerioAPI): DetectorHit | null {
  let hit: DetectorHit | null = null;
  $('a[href]').each((_, el) => {
    if (hit) return;
    const href = $(el).attr('href') ?? '';
    if (href.startsWith('whatsapp:') || WHATSAPP_HOST_RE.test(href)) {
      hit = {
        kind: 'DIRECT_OBSERVATION',
        observation: 'A WhatsApp / direct-message contact control is present.',
        selector: 'a[href]',
        excerpt: clip(href),
        confidence: 'HIGH',
      };
    }
  });
  return hit;
}

function detectMobileSticky($: CheerioAPI): DetectorHit | null {
  let hit: DetectorHit | null = null;
  $('[style], [class]').each((_, el) => {
    if (hit) return;
    const $el = $(el);
    const style = ($el.attr('style') ?? '').toLowerCase();
    const cls = ($el.attr('class') ?? '').toLowerCase();
    const positioned = /position\s*:\s*(fixed|sticky)/.test(style) || /\b(sticky|fixed|floating)\b/.test(cls);
    if (!positioned) return;
    const hasContact = $el.find('a[href^="tel:"], a[href^="whatsapp:"], a[href*="wa.me"]').length > 0
      || BOOKING_RE.test(norm($el.text()));
    if (!hasContact) return;
    hit = {
      kind: 'DETERMINISTIC_INTERPRETATION',
      observation: 'A persistent (sticky/fixed) contact control is present in the mobile viewport.',
      selector: style ? '[style*=position]' : '[class*=sticky]',
      excerpt: clip(norm($el.text()) || cls),
      confidence: 'MEDIUM',
    };
  });
  return hit;
}

function detectServices($: CheerioAPI): DetectorHit | null {
  const found = headingOrNav($, SERVICES_RE);
  if (!found) return null;
  return {
    kind: 'DIRECT_OBSERVATION',
    observation: 'A services/treatments information section is present.',
    selector: found.structured ? found.el : 'a',
    excerpt: clip(found.text),
    confidence: found.structured ? 'HIGH' : 'MEDIUM',
  };
}

function detectLocation($: CheerioAPI): DetectorHit | null {
  const addr = $('address').first();
  if (addr.length > 0 && norm(addr.text())) {
    return {
      kind: 'DIRECT_OBSERVATION',
      observation: 'A postal address is present in a structured <address> element.',
      selector: 'address',
      excerpt: clip(addr.text()),
      confidence: 'HIGH',
    };
  }
  let mapHit: DetectorHit | null = null;
  $('a[href]').each((_, el) => {
    if (mapHit) return;
    const href = $(el).attr('href') ?? '';
    if (/(google\.[a-z.]+\/maps|maps\.google|goo\.gl\/maps|openstreetmap\.org)/i.test(href)) {
      mapHit = {
        kind: 'DIRECT_OBSERVATION',
        observation: 'A map / location link is present.',
        selector: 'a[href]',
        excerpt: clip(href),
        confidence: 'HIGH',
      };
    }
  });
  return mapHit;
}

function detectOpeningHours($: CheerioAPI): DetectorHit | null {
  const bodyText = norm($('body').text());
  if (!HOURS_RE.test(bodyText)) return null;
  const structured = $('time, dl, table').filter((_, el) => HOURS_RE.test(norm($(el).text()))).length > 0;
  return {
    kind: 'DIRECT_OBSERVATION',
    observation: 'Opening-hours information is present on the page.',
    selector: structured ? 'time,dl,table' : 'body',
    excerpt: clip((HOURS_RE.exec(bodyText)?.[0] ?? '') || 'opening hours'),
    // Text-only presence is layout-dependent → MEDIUM; a structured element → HIGH.
    confidence: structured ? 'HIGH' : 'MEDIUM',
  };
}

function detectTeam($: CheerioAPI): DetectorHit | null {
  const found = headingOrNav($, ABOUT_TEAM_RE);
  if (!found) return null;
  return {
    kind: 'DIRECT_OBSERVATION',
    observation: 'Team / practitioner information is present.',
    selector: found.structured ? found.el : 'a',
    excerpt: clip(found.text),
    confidence: found.structured ? 'HIGH' : 'MEDIUM',
  };
}

function detectTestimonial($: CheerioAPI): DetectorHit | null {
  const found = headingOrNav($, TESTIMONIAL_RE);
  if (!found) return null;
  return {
    kind: 'DIRECT_OBSERVATION',
    observation: 'An on-site testimonial / review section is present.',
    selector: found.structured ? found.el : 'a',
    excerpt: clip(found.text),
    // Non-comparative: records only that such a SECTION exists on the page, never any rating value.
    confidence: found.structured ? 'HIGH' : 'MEDIUM',
  };
}

function detectPricing($: CheerioAPI): DetectorHit | null {
  const found = headingOrNav($, PRICING_RE);
  if (!found) return null;
  return {
    kind: 'DIRECT_OBSERVATION',
    observation: 'Pricing / financing information is present.',
    selector: found.structured ? found.el : 'a',
    excerpt: clip(found.text),
    confidence: found.structured ? 'HIGH' : 'MEDIUM',
  };
}

function detectEmergency($: CheerioAPI): DetectorHit | null {
  const bodyText = norm($('body').text());
  const m = EMERGENCY_RE.exec(bodyText);
  if (!m) return null;
  return {
    kind: 'DIRECT_OBSERVATION',
    observation: 'An emergency / urgent-service message is present.',
    selector: 'body',
    excerpt: clip(m[0]),
    confidence: 'MEDIUM',
  };
}

function detectLanguageSupport($: CheerioAPI): DetectorHit | null {
  const alternates = $('link[rel="alternate"][hreflang]');
  const langs = new Set<string>();
  alternates.each((_, el) => {
    const hl = ($(el).attr('hreflang') ?? '').toLowerCase().split('-')[0];
    if (hl && hl !== 'x-default') langs.add(hl);
  });
  if (langs.size >= 2) {
    return {
      kind: 'DIRECT_OBSERVATION',
      observation: 'Multiple language versions are offered (hreflang alternates).',
      selector: 'link[rel=alternate][hreflang]',
      excerpt: clip([...langs].sort().join(',')),
      confidence: 'HIGH',
    };
  }
  // A language switcher control (text-based) is a weaker, layout-dependent signal.
  let switcher: DetectorHit | null = null;
  $('a[hreflang], [class*="lang"] a, [class*="language"] a').each((_, el) => {
    if (switcher) return;
    const hl = ($(el).attr('hreflang') ?? '').toLowerCase();
    const text = norm($(el).text());
    if (hl || /\b(deutsch|english|français|francais|español|espanol|italiano|中文|عربى)\b/i.test(text)) {
      switcher = {
        kind: 'DETERMINISTIC_INTERPRETATION',
        observation: 'A language-switching control is present.',
        selector: 'a[hreflang]',
        excerpt: clip(hl || text),
        confidence: 'MEDIUM',
      };
    }
  });
  return switcher;
}

function detectFaq($: CheerioAPI): DetectorHit | null {
  const found = headingOrNav($, FAQ_RE);
  if (!found) return null;
  return {
    kind: 'DIRECT_OBSERVATION',
    observation: 'FAQ content is present.',
    selector: found.structured ? found.el : 'a',
    excerpt: clip(found.text),
    confidence: found.structured ? 'HIGH' : 'MEDIUM',
  };
}

/** Per-page single-observation detectors, keyed by category. Depth categories are computed separately. */
const PAGE_DETECTORS: Partial<Record<EvidenceCategory, (($: CheerioAPI) => DetectorHit | null)>> = {
  BOOKING_CTA_VISIBLE: detectBookingCta,
  PHONE_VISIBLE: detectPhone,
  WHATSAPP_OR_DIRECT_MESSAGE_VISIBLE: detectWhatsApp,
  SERVICE_INFORMATION_VISIBLE: detectServices,
  LOCATION_VISIBLE: detectLocation,
  OPENING_HOURS_VISIBLE: detectOpeningHours,
  TEAM_OR_PRACTITIONER_INFORMATION: detectTeam,
  ON_SITE_TESTIMONIAL_OR_REVIEW_SECTION: detectTestimonial,
  PRICING_OR_FINANCING_INFORMATION: detectPricing,
  EMERGENCY_OR_URGENT_SERVICE_MESSAGE: detectEmergency,
  LANGUAGE_SUPPORT_VISIBLE: detectLanguageSupport,
  FAQ_CONTENT_VISIBLE: detectFaq,
};

/** Deterministic mobile navigation depth: 1 if contact/booking is a top-level nav link, else 2 (behind a menu toggle). */
function computeMobileNavDepth($: CheerioAPI): DetectorHit {
  const navLinks = $('nav a, header a');
  let topLevel = false;
  navLinks.each((_, el) => {
    const t = norm($(el).text());
    const href = $(el).attr('href') ?? '';
    if (CONTACT_RE.test(t) || CONTACT_RE.test(href) || BOOKING_RE.test(t) || BOOKING_RE.test(href)) topLevel = true;
  });
  const hasToggle = $('[class*="hamburger"], [class*="menu-toggle"], button[aria-controls], [aria-label*="menu" i]').length > 0;
  const depth = topLevel ? 1 : hasToggle ? 2 : 2;
  return {
    kind: 'DETERMINISTIC_INTERPRETATION',
    observation: `Reaching contact/booking from the mobile navigation requires ${String(depth)} step(s).`,
    selector: 'nav a',
    excerpt: null,
    numericValue: depth,
    confidence: 'MEDIUM',
  };
}

/** Deterministic contact-path depth from the homepage: 0 if contact info on the page, 1 if a contact link, else 2. */
function computeContactPathDepth($: CheerioAPI): DetectorHit {
  const onPage = $('a[href^="tel:"]').length > 0 || ($('address').first().length > 0 && norm($('address').first().text()) !== '');
  let hasContactLink = false;
  $('a[href]').each((_, el) => {
    const t = norm($(el).text());
    const href = $(el).attr('href') ?? '';
    if (CONTACT_RE.test(t) || CONTACT_RE.test(href)) hasContactLink = true;
  });
  const depth = onPage ? 0 : hasContactLink ? 1 : 2;
  return {
    kind: 'DETERMINISTIC_INTERPRETATION',
    observation: `Reaching contact details from the homepage requires ${String(depth)} click(s).`,
    selector: onPage ? 'a[href^=tel:]|address' : 'a[href]',
    excerpt: null,
    numericValue: depth,
    confidence: onPage ? 'HIGH' : 'MEDIUM',
  };
}

function toObservation(
  competitorCandidateId: string,
  normalizedOrigin: string,
  category: EvidenceCategory,
  page: CapturedPageInput,
  hit: DetectorHit,
): EvidenceObservation {
  return {
    competitorCandidateId,
    evidenceCategory: category,
    observationKind: hit.kind,
    observation: hit.observation,
    sourcePageUrl: page.finalUrl,
    normalizedOrigin,
    selector: hit.selector,
    sourceExcerpt: hit.excerpt,
    profile: page.profile,
    numericValue: hit.numericValue ?? null,
    confidence: hit.confidence,
    withholdingReason: hit.withholdingReason ?? null,
  };
}

const CONFIDENCE_RANK: Record<EvidenceConfidence, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };

/**
 * Derive all deterministic observations for ONE competitor from its captured page set. Presence
 * detectors run on EVERY reproducible page (homepage + bounded same-origin secondary pages);
 * mobile-only + depth categories are computed from the homepage structure. At most one observation
 * per (category, profile) — the highest-confidence reproducible hit wins. No AI, no network:
 * identical HTML always yields identical observations.
 */
export function deriveCompetitorObservations(
  competitorCandidateId: string,
  normalizedOrigin: string,
  pages: CapturedPageInput[],
): EvidenceObservation[] {
  const okPages = pages.filter((p) => p.ok && p.html.trim() !== '');
  const homepages = okPages.filter((p) => p.role === 'homepage');
  const byKey = new Map<string, EvidenceObservation>();

  const consider = (obs: EvidenceObservation): void => {
    const key = `${obs.evidenceCategory}|${obs.profile}`;
    const prev = byKey.get(key);
    if (!prev || CONFIDENCE_RANK[obs.confidence] > CONFIDENCE_RANK[prev.confidence]) byKey.set(key, obs);
  };

  // Presence detectors over every reproducible page (a contact/services page carries evidence too).
  for (const page of okPages) {
    const $ = cheerio.load(page.html);
    for (const [category, detector] of Object.entries(PAGE_DETECTORS) as [EvidenceCategory, (($: CheerioAPI) => DetectorHit | null)][]) {
      const hit = detector($);
      if (hit) consider(toObservation(competitorCandidateId, normalizedOrigin, category, page, hit));
    }
  }

  // Mobile-only + structural depth categories are anchored to the homepage of each profile.
  for (const page of homepages) {
    const $ = cheerio.load(page.html);
    if (page.profile === 'mobile') {
      consider(toObservation(competitorCandidateId, normalizedOrigin, 'MOBILE_STICKY_CONTACT_CONTROL', page, detectMobileSticky($) ?? {
        kind: 'DETERMINISTIC_INTERPRETATION',
        observation: 'No persistent (sticky/fixed) contact control was reproducibly detected in the mobile viewport.',
        selector: null,
        excerpt: null,
        confidence: 'LOW',
        withholdingReason: 'AMBIGUOUS',
      }));
      consider(toObservation(competitorCandidateId, normalizedOrigin, 'MOBILE_NAVIGATION_DEPTH', page, computeMobileNavDepth($)));
    }
    if (page.profile === 'desktop') {
      consider(toObservation(competitorCandidateId, normalizedOrigin, 'CONTACT_PATH_DEPTH', page, computeContactPathDepth($)));
    }
  }
  return [...byKey.values()];
}
