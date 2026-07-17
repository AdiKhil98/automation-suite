import { type FactType } from '../lead-facts/lead-fact.js';

/** A demo-relevant fact extracted from verified capture evidence. */
export interface CandidateFact {
  factType: FactType;
  value: string;
  normalizedValue: string | null;
  sourceUrl: string | null;
}

/** Minimal shape of a capture_evidence row we read (matches EvidenceRef). */
export interface EvidenceLike {
  evidenceType: string;
  sourceUrl: string | null;
  extractedValue: string | null;
  normalizedValue: string | null;
}

export const DEMO_FACT_EXTRACTOR_VERSION = 'demo-fact-extract-1';

// Dental service terms (DE + EN). A nav label / heading matching one is treated as a
// concretely displayed service — never invented.
const SERVICE_KEYWORDS = [
  'prophylax', 'zahnreinigung', 'implantat', 'implantolog', 'bleaching', 'weißung', 'aufhellung',
  'füllung', 'krone', 'brücke', 'wurzel', 'endodont', 'parodont', 'kinderzahn', 'kieferorthopäd',
  'ästhet', 'veneer', 'prothes', 'zahnersatz', 'vorsorge', 'kariesbehandlung', 'zahnspange',
  'cleaning', 'whitening', 'implant', 'filling', 'crown', 'bridge', 'root canal', 'orthodont',
  'aligner', 'invisalign', 'prevention', 'checkup', 'veneers', 'denture', 'periodont',
];
const GENERIC_NAV = /^(home|start|startseite|kontakt|contact|impressum|über uns|about|team|anfahrt|datenschutz|news|blog|aktuelles|praxis)$/i;
const CONTACT_PATH = /kontakt|contact/i;
const BOOKING_PATH = /termin|booking|appointment|buchen|online-?termin|book/i;
// Known third-party online-booking platforms (host match → verified booking destination).
const BOOKING_HOSTS = /(^|\.)(doctolib\.|jameda\.|doctena\.|samedi\.|dr-flex\.|termed\.|zocdoc\.|treatwell\.)/i;

const pathOf = (href: string): string => {
  try { return new URL(href).pathname; } catch { return href; }
};
const hostOf = (href: string): string => {
  try { return new URL(href).host; } catch { return ''; }
};
const normPhone = (raw: string): string => raw.replace(/[^\d+]/g, '');

/**
 * Deterministically derive demo-relevant facts from capture evidence. Prefers JSON-LD
 * (structured, reliable) then falls back to tel/mailto/footer/link/nav evidence. Every
 * value is something the site actually displays — nothing is invented. One fact per type.
 */
export function extractDemoFacts(evidence: EvidenceLike[]): CandidateFact[] {
  const out: CandidateFact[] = [];
  const seen = new Set<FactType>();
  const push = (factType: FactType, value: string | null | undefined, sourceUrl: string | null, normalized?: string | null): void => {
    const v = (value ?? '').trim();
    if (seen.has(factType) || v === '') return;
    seen.add(factType);
    out.push({ factType, value: v.slice(0, 500), normalizedValue: (normalized ?? v.toLowerCase()).slice(0, 500), sourceUrl });
  };

  // --- JSON-LD (best-effort; capture may truncate it) ---
  for (const e of evidence.filter((x) => x.evidenceType === 'structured_data')) {
    const nodes = parseJsonLd(e.extractedValue ?? '');
    for (const node of nodes) {
      if (typeof node.telephone === 'string') push('phone', node.telephone, e.sourceUrl, normPhone(node.telephone));
      if (typeof node.email === 'string') push('contact_email', node.email, e.sourceUrl);
      const addr = formatAddress(node.address);
      if (addr) push('formatted_address', addr, e.sourceUrl);
      const hours = formatHours(node.openingHours ?? node.openingHoursSpecification);
      if (hours) push('opening_hours', hours, e.sourceUrl);
    }
  }

  // --- Evidence fallbacks ---
  const tel = evidence.find((x) => x.evidenceType === 'tel');
  if (tel) push('phone', tel.extractedValue, tel.sourceUrl, normPhone(tel.extractedValue ?? ''));
  const mail = evidence.find((x) => x.evidenceType === 'mailto');
  if (mail) push('contact_email', mail.extractedValue, mail.sourceUrl);

  const footer = evidence.find((x) => x.evidenceType === 'footer_legal');
  const footAddr = extractAddressFromText(footer?.extractedValue ?? '');
  if (footAddr) push('formatted_address', footAddr, footer?.sourceUrl ?? null);

  for (const e of evidence.filter((x) => x.evidenceType === 'link')) {
    const href = e.extractedValue ?? '';
    const p = pathOf(href);
    if (BOOKING_HOSTS.test(hostOf(href)) || BOOKING_PATH.test(p)) push('booking_url', href, e.sourceUrl);
    else if (CONTACT_PATH.test(p)) push('contact_form_url', href, e.sourceUrl);
  }

  const services = extractServices(evidence);
  if (services.length > 0) push('services', services.join(' | '), null);

  return out;
}

function parseJsonLd(text: string): Array<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(text);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const flat: Array<Record<string, unknown>> = [];
    for (const item of arr) {
      if (item && typeof item === 'object') {
        flat.push(item as Record<string, unknown>);
        const graph = (item as { '@graph'?: unknown })['@graph'];
        if (Array.isArray(graph)) for (const g of graph) if (g && typeof g === 'object') flat.push(g as Record<string, unknown>);
      }
    }
    return flat;
  } catch {
    return [];
  }
}

function formatAddress(address: unknown): string | null {
  if (typeof address === 'string') return address.trim() || null;
  if (address && typeof address === 'object') {
    const a = address as Record<string, unknown>;
    const parts = [a.streetAddress, a.postalCode, a.addressLocality].filter((p): p is string => typeof p === 'string' && p.trim() !== '');
    if (parts.length > 0) return parts.join(', ');
  }
  return null;
}

function formatHours(hours: unknown): string | null {
  if (typeof hours === 'string') return hours.trim() || null;
  if (Array.isArray(hours)) {
    const strs = hours.filter((h): h is string => typeof h === 'string');
    if (strs.length > 0) return strs.join('; ').slice(0, 300);
    const specs = hours
      .filter((h): h is Record<string, unknown> => Boolean(h) && typeof h === 'object')
      .map((s) => {
        const day = Array.isArray(s.dayOfWeek) ? s.dayOfWeek.join('/') : String(s.dayOfWeek ?? '');
        const dayShort = day.replace(/https?:\/\/schema\.org\//g, '');
        return dayShort && s.opens && s.closes ? `${dayShort} ${String(s.opens)}–${String(s.closes)}` : '';
      })
      .filter(Boolean);
    if (specs.length > 0) return specs.join('; ').slice(0, 300);
  }
  return null;
}

// German-style address line: street + number, or a 5-digit postal code + locality.
function extractAddressFromText(text: string): string | null {
  const m = text.match(/([A-Za-zäöüÄÖÜß.\- ]+\s\d+[a-z]?,?\s*)?\b(\d{5})\s+([A-Za-zäöüÄÖÜß.\- ]{2,40})/);
  return m ? m[0].replace(/\s+/g, ' ').trim().slice(0, 200) : null;
}

function extractServices(evidence: EvidenceLike[]): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const e of evidence) {
    if (e.evidenceType !== 'nav_label' && e.evidenceType !== 'heading') continue;
    const text = (e.extractedValue ?? '').trim();
    if (text === '' || text.length > 60 || GENERIC_NAV.test(text)) continue;
    const lower = text.toLowerCase();
    if (!SERVICE_KEYWORDS.some((k) => lower.includes(k))) continue;
    const key = lower.replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(text);
    if (found.length >= 8) break;
  }
  return found;
}
