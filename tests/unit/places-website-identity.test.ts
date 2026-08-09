import { describe, expect, it } from 'vitest';
import {
  businessNameTokens,
  domainIdentity,
  domainMatchesBusinessName,
  sameRegistrableDomain,
  scoreCandidate,
  type VerifyOptions,
} from '../../src/domain/enrichment/verify-domain.js';
import {
  type Candidate,
  type EnrichmentContext,
  type ExtractedPage,
} from '../../src/domain/enrichment/types.js';

// Niche present → the fallback is eligible; category still gates per-candidate.
const OPTS: VerifyOptions = {
  minConfidence: 0.6,
  ambiguousMargin: 0.1,
  nicheAllowedCategories: ['dentist', 'dental clinic', 'orthodontist'],
};

function page(over: Partial<ExtractedPage>): ExtractedPage {
  return {
    requestedUrl: 'https://example.co.uk',
    finalUrl: 'https://example.co.uk/',
    host: 'example.co.uk',
    httpStatus: 200,
    title: null,
    visibleTextLength: 500,
    visibleTextSample: '',
    scriptCount: 1,
    hasEmptyAppRoot: false,
    phones: [],
    emails: [],
    contactFormUrls: [],
    structured: [],
    sameOriginLinks: [],
    bookingPathLinks: [],
    legalText: null,
    ...over,
  };
}

const placesCand = (url: string): Candidate => ({ url, discoverySource: 'website_hint' });

/** Build a context with no phone/address so ONLY the fallback (or weak signals) can fire. */
function ctx(over: Partial<EnrichmentContext>): EnrichmentContext {
  return { businessName: null, phone: null, formattedAddress: null, city: null, country: 'GB', category: 'dental_clinic', ...over };
}

const hasFallback = (signals: { signalType: string }[]): boolean =>
  signals.some((s) => s.signalType === 'places_website_identity_match');

describe('places_website_identity_match — fires (all conditions met)', () => {
  it('Shirley-style: exact concatenated domain/name match → strong fallback → VERIFIED', () => {
    const v = scoreCandidate(
      placesCand('http://shirleydentalpractice.co.uk/'),
      [page({
        host: 'www.shirleydentalpractice.co.uk',
        finalUrl: 'https://www.shirleydentalpractice.co.uk/',
        visibleTextSample: 'shirley dental practice croydon',
      })],
      ctx({ businessName: 'Shirley Dental Practice', city: 'Croydon' }),
      OPTS,
    );
    expect(v.decision).toBe('VERIFIED');
    expect(hasFallback(v.signals)).toBe(true);
    const s = v.signals.find((x) => x.signalType === 'places_website_identity_match')!;
    expect(s.strong).toBe(true);
    // No other strong signal was needed — the fallback alone carried it.
    expect(v.signals.filter((x) => x.strong).map((x) => x.signalType)).toEqual(['places_website_identity_match']);
    expect(v.facts.map((f) => f.factType)).toEqual(expect.arrayContaining(['official_domain', 'official_website_url']));
  });

  it('Whitgift-style: ≥60% token coverage in the domain → strong fallback → VERIFIED', () => {
    const v = scoreCandidate(
      placesCand('https://www.whitgiftdental.co.uk/'),
      [page({
        host: 'whitgiftdental.co.uk',
        finalUrl: 'https://whitgiftdental.co.uk/',
        visibleTextSample: 'the whitgift dental practice croydon',
      })],
      ctx({ businessName: 'The Whitgift Dental Practice', city: 'Croydon' }),
      OPTS,
    );
    expect(v.decision).toBe('VERIFIED');
    expect(hasFallback(v.signals)).toBe(true);
  });

  it('WC-DP-style: exact acronym of the name equals the domain identity → strong fallback → VERIFIED', () => {
    const v = scoreCandidate(
      placesCand('http://www.wc-dp.co.uk/'),
      [page({
        host: 'wc-dp.co.uk',
        finalUrl: 'https://wc-dp.co.uk/',
        visibleTextSample: 'west croydon dental practice croydon',
      })],
      ctx({ businessName: 'West Croydon Dental Practice', city: 'Croydon' }),
      OPTS,
    );
    expect(v.decision).toBe('VERIFIED');
    expect(hasFallback(v.signals)).toBe(true);
  });

  it('allows http→https and www redirect changes on the same registrable domain', () => {
    const v = scoreCandidate(
      placesCand('http://shirleydentalpractice.co.uk/'),
      [page({
        host: 'www.shirleydentalpractice.co.uk',
        finalUrl: 'https://www.shirleydentalpractice.co.uk/',
        visibleTextSample: 'shirley dental practice croydon',
      })],
      ctx({ businessName: 'Shirley Dental Practice', city: 'Croydon' }),
      OPTS,
    );
    expect(v.decision).toBe('VERIFIED');
    expect(hasFallback(v.signals)).toBe(true);
  });
});

describe('places_website_identity_match — fails closed (any condition missing)', () => {
  const shirleyPage = (over: Partial<ExtractedPage> = {}): ExtractedPage =>
    page({
      host: 'www.shirleydentalpractice.co.uk',
      finalUrl: 'https://www.shirleydentalpractice.co.uk/',
      visibleTextSample: 'shirley dental practice croydon',
      ...over,
    });

  it('missing on-page city → no fallback', () => {
    const v = scoreCandidate(
      placesCand('http://shirleydentalpractice.co.uk/'),
      [shirleyPage({ visibleTextSample: 'shirley dental practice' })], // no city token
      ctx({ businessName: 'Shirley Dental Practice', city: 'Croydon' }),
      OPTS,
    );
    expect(hasFallback(v.signals)).toBe(false);
    expect(v.decision).not.toBe('VERIFIED');
  });

  it('missing on-page business name → no fallback', () => {
    const v = scoreCandidate(
      placesCand('http://shirleydentalpractice.co.uk/'),
      [shirleyPage({ visibleTextSample: 'welcome to croydon' })], // city only, no name
      ctx({ businessName: 'Shirley Dental Practice', city: 'Croydon' }),
      OPTS,
    );
    expect(hasFallback(v.signals)).toBe(false);
    expect(v.decision).not.toBe('VERIFIED');
  });

  it('category outside the campaign niche → no fallback', () => {
    const v = scoreCandidate(
      placesCand('http://shirleydentalpractice.co.uk/'),
      [shirleyPage()],
      ctx({ businessName: 'Shirley Dental Practice', city: 'Croydon', category: 'restaurant' }),
      OPTS,
    );
    expect(hasFallback(v.signals)).toBe(false);
    expect(v.decision).not.toBe('VERIFIED');
  });

  it('no niche supplied (nicheAllowedCategories undefined) → no fallback', () => {
    const v = scoreCandidate(
      placesCand('http://shirleydentalpractice.co.uk/'),
      [shirleyPage()],
      ctx({ businessName: 'Shirley Dental Practice', city: 'Croydon' }),
      { minConfidence: 0.6, ambiguousMargin: 0.1 },
    );
    expect(hasFallback(v.signals)).toBe(false);
    expect(v.decision).not.toBe('VERIFIED');
  });

  it('non-Places provenance (discoverySource !== website_hint) → no fallback', () => {
    const v = scoreCandidate(
      { url: 'http://shirleydentalpractice.co.uk/', discoverySource: 'manual' },
      [shirleyPage()],
      ctx({ businessName: 'Shirley Dental Practice', city: 'Croydon' }),
      OPTS,
    );
    expect(hasFallback(v.signals)).toBe(false);
    expect(v.decision).not.toBe('VERIFIED');
  });

  it('cross-domain redirect (final domain differs from the Places-supplied one) → no fallback', () => {
    const v = scoreCandidate(
      placesCand('http://shirleydentalpractice.co.uk/'),
      [page({
        host: 'shirley-dental-group.com',
        finalUrl: 'https://shirley-dental-group.com/',
        visibleTextSample: 'shirley dental practice croydon',
      })],
      ctx({ businessName: 'Shirley Dental Practice', city: 'Croydon' }),
      OPTS,
    );
    expect(hasFallback(v.signals)).toBe(false);
    expect(v.decision).not.toBe('VERIFIED');
  });

  it('domain match only (no on-page name AND city) → never verifies', () => {
    const v = scoreCandidate(
      placesCand('http://shirleydentalpractice.co.uk/'),
      [shirleyPage({ visibleTextSample: 'home about services' })],
      ctx({ businessName: 'Shirley Dental Practice', city: 'Croydon' }),
      OPTS,
    );
    expect(hasFallback(v.signals)).toBe(false);
    expect(v.decision).not.toBe('VERIFIED');
  });

  it('on-page name + city but domain does NOT match the name → no fallback (AMBIGUOUS)', () => {
    const v = scoreCandidate(
      placesCand('http://bs123.co.uk/'),
      [page({
        host: 'bs123.co.uk',
        finalUrl: 'https://bs123.co.uk/',
        visibleTextSample: 'bright smile dental croydon',
      })],
      ctx({ businessName: 'Bright Smile Dental', city: 'Croydon' }),
      OPTS,
    );
    expect(hasFallback(v.signals)).toBe(false);
    expect(v.decision).toBe('AMBIGUOUS');
  });

  it('unrelated acronym (name acronym ≠ domain) → no fallback', () => {
    const v = scoreCandidate(
      placesCand('http://abcd.co.uk/'),
      [page({
        host: 'abcd.co.uk',
        finalUrl: 'https://abcd.co.uk/',
        visibleTextSample: 'west croydon dental practice croydon',
      })],
      ctx({ businessName: 'West Croydon Dental Practice', city: 'Croydon' }),
      OPTS,
    );
    expect(hasFallback(v.signals)).toBe(false);
    expect(v.decision).toBe('AMBIGUOUS');
  });

  it('below 60% meaningful-token coverage → no fallback', () => {
    const v = scoreCandidate(
      placesCand('http://alphaonly.co.uk/'),
      [page({
        host: 'alphaonly.co.uk',
        finalUrl: 'https://alphaonly.co.uk/',
        visibleTextSample: 'alpha beta gamma dental croydon',
      })],
      ctx({ businessName: 'Alpha Beta Gamma Dental', city: 'Croydon' }),
      OPTS,
    );
    expect(hasFallback(v.signals)).toBe(false);
    expect(v.decision).toBe('AMBIGUOUS');
  });
});

describe('existing verification behaviour is unchanged', () => {
  it('structured-data telephone match still VERIFIES (no dependence on the fallback)', () => {
    const v = scoreCandidate(
      { url: 'https://acme.example', discoverySource: 'manual' },
      [page({
        host: 'acme.example',
        finalUrl: 'https://acme.example/',
        visibleTextSample: 'acme dental',
        structured: [{ type: 'Dentist', name: 'Acme Dental', telephone: '+441614960000' }],
      })],
      { businessName: 'Acme Dental', phone: '0161 496 0000', city: 'Manchester', country: 'GB', category: 'dental_clinic' },
      OPTS,
    );
    expect(v.decision).toBe('VERIFIED');
    expect(v.signals.some((s) => s.signalType === 'structured_data' && s.strong)).toBe(true);
  });

  it('Mayfield path (structured data + address) unchanged — still VERIFIED via the original strong signals', () => {
    const v = scoreCandidate(
      placesCand('https://www.mayfield-dental.co.uk/'),
      [page({
        host: 'www.mayfield-dental.co.uk',
        finalUrl: 'https://www.mayfield-dental.co.uk/',
        visibleTextSample: 'mayfield dental 43 mayfield rd south croydon',
        structured: [{ type: 'Dentist', name: 'Mayfield Dental', streetAddress: '43 Mayfield Rd' }],
      })],
      ctx({ businessName: 'Mayfield Dental', city: 'South Croydon', formattedAddress: '43 Mayfield Rd, South Croydon CR2 0BG, UK' }),
      OPTS,
    );
    expect(v.decision).toBe('VERIFIED');
    expect(v.signals.some((s) => s.signalType === 'name_address' && s.strong)).toBe(true);
  });

  it('genuinely ambiguous site (weak signals only, unrelated domain) stays AMBIGUOUS', () => {
    const v = scoreCandidate(
      placesCand('http://xyzcorp.co.uk/'),
      [page({
        host: 'xyzcorp.co.uk',
        finalUrl: 'https://xyzcorp.co.uk/',
        visibleTextSample: 'shirley dental practice croydon',
      })],
      ctx({ businessName: 'Shirley Dental Practice', city: 'Croydon' }),
      OPTS,
    );
    expect(v.decision).toBe('AMBIGUOUS');
    expect(v.signals.every((s) => !s.strong)).toBe(true);
  });
});

describe('deterministic identity helpers', () => {
  it('domainIdentity strips www + public suffix + separators', () => {
    expect(domainIdentity('www.shirleydentalpractice.co.uk')).toBe('shirleydentalpractice');
    expect(domainIdentity('wc-dp.co.uk')).toBe('wcdp');
    expect(domainIdentity('whitgiftdental.co.uk')).toBe('whitgiftdental');
    expect(domainIdentity(null)).toBeNull();
  });

  it('businessNameTokens drops only the explicit generic set', () => {
    expect(businessNameTokens('The Whitgift Dental Practice')).toEqual(['whitgift', 'dental']);
    expect(businessNameTokens('West Croydon Dental Practice')).toEqual(['west', 'croydon', 'dental']);
    expect(businessNameTokens('Acme Ltd Clinic')).toEqual(['acme']);
  });

  it('domainMatchesBusinessName: coverage OR exact acronym, never fuzzy', () => {
    expect(domainMatchesBusinessName('Shirley Dental Practice', 'shirleydentalpractice.co.uk')).toBe(true);
    expect(domainMatchesBusinessName('The Whitgift Dental Practice', 'whitgiftdental.co.uk')).toBe(true);
    expect(domainMatchesBusinessName('West Croydon Dental Practice', 'wc-dp.co.uk')).toBe(true);
    expect(domainMatchesBusinessName('Bright Smile Dental', 'bs123.co.uk')).toBe(false);
    expect(domainMatchesBusinessName('West Croydon Dental Practice', 'abcd.co.uk')).toBe(false);
    expect(domainMatchesBusinessName('Alpha Beta Gamma Dental', 'alphaonly.co.uk')).toBe(false);
  });

  it('sameRegistrableDomain: www/protocol tolerant, cross-domain false', () => {
    expect(sameRegistrableDomain('http://shirleydentalpractice.co.uk/', 'https://www.shirleydentalpractice.co.uk/')).toBe(true);
    expect(sameRegistrableDomain('http://shirleydentalpractice.co.uk/', 'https://shirley-dental-group.com/')).toBe(false);
    expect(sameRegistrableDomain(null, 'https://x.co.uk')).toBe(false);
  });
});
