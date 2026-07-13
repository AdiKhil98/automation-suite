import { isDirectoryHost } from '../../integrations/enrichment/directory-denylist.js';
import {
  normalizeAddress,
  normalizeCity,
  normalizeName,
  normalizePhone,
} from '../leads/normalize.js';
import { type EnrichmentOutcome, STRONG_SIGNALS } from './outcome.js';
import {
  type Candidate,
  type CandidateVerification,
  type EnrichmentContext,
  type ExtractedFact,
  type ExtractedPage,
  type VerificationSignal,
} from './types.js';

export interface VerifyOptions {
  minConfidence: number;
  ambiguousMargin: number;
}

// One strong signal clears the default threshold (0.6); weak signals never do alone.
const STRONG_WEIGHT = 0.7;
const WEAK_WEIGHT = 0.1;

const isStrong = (t: VerificationSignal['signalType']): boolean => STRONG_SIGNALS.includes(t);

function registrableHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

function nameTokens(name: string | null | undefined): string[] {
  const n = normalizeName(name ?? null);
  if (!n) return [];
  return n.split(' ').filter((t) => t.length >= 3 && !['the', 'and', 'ltd', 'limited'].includes(t));
}

function tokensPresent(tokens: string[], text: string): boolean {
  if (tokens.length === 0) return false;
  const hits = tokens.filter((t) => text.includes(t)).length;
  return hits >= Math.ceil(tokens.length * 0.6);
}

function addressMatch(context: EnrichmentContext, page: ExtractedPage): boolean {
  const addr = normalizeAddress(context.formattedAddress ?? null);
  if (addr) {
    const street = addr.split(' ').slice(0, 3).join(' ');
    if (street.length > 4 && page.visibleTextSample.includes(street)) return true;
  }
  for (const s of page.structured) {
    const sAddr = normalizeAddress(s.streetAddress ?? null);
    if (addr && sAddr && addr.includes(sAddr.split(' ').slice(0, 2).join(' '))) return true;
  }
  return false;
}

function isLocationPath(url: string): boolean {
  return /(location|branch|find-us|our-practice|clinic|surgery)/i.test(url);
}

/** Score a single candidate's pages into a verification with structured evidence. */
export function scoreCandidate(
  candidate: Candidate,
  pages: ExtractedPage[],
  context: EnrichmentContext,
  opts: VerifyOptions,
): CandidateVerification {
  const home = pages[0];
  const base: Omit<CandidateVerification, 'decision' | 'confidence' | 'signals' | 'facts'> = {
    requestedUrl: candidate.url,
    finalUrl: home?.finalUrl ?? null,
    host: home?.host ?? null,
    httpStatus: home?.httpStatus ?? null,
    discoverySource: candidate.discoverySource,
    isDirectory: home ? isDirectoryHost(home.host) : false,
    rejectedReason: null,
    browserRequired: false,
  };

  if (!home) {
    return { ...base, decision: 'REJECTED', confidence: 0, signals: [], facts: [], rejectedReason: 'no_page' };
  }
  if (base.isDirectory) {
    return { ...base, decision: 'REJECTED', confidence: 0, signals: [], facts: [], rejectedReason: 'directory_or_social' };
  }

  const looksClientRendered = pages.every(
    (p) => p.visibleTextLength < 200 && (p.hasEmptyAppRoot || p.scriptCount >= 5),
  );
  if (looksClientRendered) {
    return {
      ...base,
      decision: 'REJECTED',
      confidence: 0,
      signals: [],
      facts: [],
      browserRequired: true,
      rejectedReason: 'client_rendered_shell',
    };
  }

  const signals: VerificationSignal[] = [];
  const ctxPhone = normalizePhone(context.phone ?? null);
  const tokens = nameTokens(context.businessName);
  const city = normalizeCity(context.city ?? null);
  let locationPageUrl: string | null = null;

  for (const page of pages) {
    // exact phone (STRONG)
    if (ctxPhone) {
      for (const p of page.phones) {
        if (normalizePhone(p) === ctxPhone) {
          signals.push(sig('exact_phone', page.finalUrl, 'phone', p, ctxPhone, 'a[href^="tel:"]', 0.95));
          if (isLocationPath(page.finalUrl) && page.finalUrl !== home.finalUrl) locationPageUrl = page.finalUrl;
          break;
        }
      }
    }
    // structured data (STRONG)
    for (const s of page.structured) {
      const telMatch = ctxPhone && normalizePhone(s.telephone ?? null) === ctxPhone;
      const addrMatch = addressMatch(context, page);
      if (telMatch || addrMatch) {
        signals.push(sig('structured_data', page.finalUrl, telMatch ? 'phone' : 'formatted_address', s.name ?? s.type, null, 'script[ld+json]', 0.9));
      }
    }
    // name + address (STRONG)
    if (tokensPresent(tokens, page.visibleTextSample) && addressMatch(context, page)) {
      signals.push(sig('name_address', page.finalUrl, 'business_name', context.businessName ?? '', null, 'body', 0.85));
    }
    // branch/location page (STRONG)
    if (page.finalUrl !== home.finalUrl && isLocationPath(page.finalUrl) && (addressMatch(context, page) || (city && page.visibleTextSample.includes(city)))) {
      signals.push(sig('branch_location', page.finalUrl, 'formatted_address', page.finalUrl, null, 'a[location]', 0.8));
      locationPageUrl = page.finalUrl;
    }
    // legal footer (STRONG) — legal identity + city
    if (page.legalText && tokensPresent(tokens, normalizeName(page.legalText) ?? '') && city && page.visibleTextSample.includes(city)) {
      signals.push(sig('legal_footer', page.finalUrl, 'business_name', page.legalText, null, 'footer', 0.8));
    }
    // WEAK signals
    if (tokensPresent(tokens, page.visibleTextSample)) {
      signals.push(sig('name_tokens', page.finalUrl, 'business_name', context.businessName ?? '', null, 'body', 0.3));
    }
    if (city && page.visibleTextSample.includes(city)) {
      signals.push(sig('city_mention', page.finalUrl, 'city', context.city ?? '', city, 'body', 0.2));
    }
  }

  const strongCount = signals.filter((s) => isStrong(s.signalType)).length;
  const weakCount = signals.length - strongCount;
  const confidence = Math.min(1, strongCount * STRONG_WEIGHT + weakCount * WEAK_WEIGHT);

  let decision: CandidateVerification['decision'];
  if (strongCount >= 1 && confidence >= opts.minConfidence) decision = 'VERIFIED';
  else if (signals.length > 0) decision = 'AMBIGUOUS';
  else return { ...base, decision: 'REJECTED', confidence: 0, signals: [], facts: [], rejectedReason: 'no_signals' };

  const facts = decision === 'VERIFIED' ? extractFacts(home, pages, locationPageUrl) : [];
  return { ...base, decision, confidence, signals, facts };
}

function extractFacts(
  home: ExtractedPage,
  pages: ExtractedPage[],
  locationPageUrl: string | null,
): ExtractedFact[] {
  const url = home.finalUrl;
  const domain = registrableHost(home.host);
  const facts: ExtractedFact[] = [
    { factType: 'official_domain', value: domain, normalizedValue: domain, sourceUrl: url, confidence: 0.9 },
    { factType: 'official_website_url', value: url, normalizedValue: url, sourceUrl: url, confidence: 0.9 },
  ];
  if (locationPageUrl) {
    facts.push({ factType: 'official_location_page_url', value: locationPageUrl, normalizedValue: locationPageUrl, sourceUrl: locationPageUrl, confidence: 0.8 });
  }
  const email = pages.flatMap((p) => p.emails)[0];
  if (email) facts.push({ factType: 'contact_email', value: email, normalizedValue: email.toLowerCase(), sourceUrl: url, confidence: 0.9 });
  const form = pages.flatMap((p) => p.contactFormUrls)[0];
  if (form) facts.push({ factType: 'contact_form_url', value: form, normalizedValue: null, sourceUrl: url, confidence: 0.8 });
  const structuredName = pages.flatMap((p) => p.structured).map((s) => s.name).find(Boolean);
  if (structuredName) facts.push({ factType: 'business_name', value: structuredName, normalizedValue: normalizeName(structuredName), sourceUrl: url, confidence: 0.7 });
  return facts;
}

function sig(
  signalType: VerificationSignal['signalType'],
  pageUrl: string,
  matchedFactType: VerificationSignal['matchedFactType'],
  extractedValue: string,
  normalizedValue: string | null,
  selector: string | null,
  confidence: number,
): VerificationSignal {
  return {
    signalType,
    pageUrl,
    matchedFactType,
    extractedValue,
    normalizedValue,
    selector,
    confidence,
    strong: isStrong(signalType),
  };
}

/** Aggregate candidate verifications into a lead-level outcome + winner. */
export function decideOutcome(
  candidates: CandidateVerification[],
  opts: VerifyOptions,
): { outcome: EnrichmentOutcome; winner: CandidateVerification | null } {
  if (candidates.length === 0) return { outcome: 'NO_CANDIDATE', winner: null };

  const verified = candidates
    .filter((c) => c.decision === 'VERIFIED')
    .sort((a, b) => b.confidence - a.confidence);

  if (verified.length >= 1) {
    const top = verified[0];
    const second = verified[1];
    const topDomain = top?.host ? registrableHost(top.host) : '';
    const secondDomain = second?.host ? registrableHost(second.host) : '';
    if (second && topDomain !== secondDomain && top.confidence - second.confidence < opts.ambiguousMargin) {
      return { outcome: 'AMBIGUOUS', winner: null };
    }
    return { outcome: 'VERIFIED', winner: top ?? null };
  }
  if (candidates.some((c) => c.decision === 'AMBIGUOUS')) return { outcome: 'AMBIGUOUS', winner: null };
  if (candidates.some((c) => c.browserRequired)) return { outcome: 'BROWSER_REQUIRED', winner: null };
  return { outcome: 'NO_VERIFIED_CANDIDATE', winner: null };
}
