import { describe, expect, it } from 'vitest';
import { decideOutcome, scoreCandidate } from '../../src/domain/enrichment/verify-domain.js';
import {
  type Candidate,
  type CandidateVerification,
  type EnrichmentContext,
  type ExtractedPage,
} from '../../src/domain/enrichment/types.js';

const OPTS = { minConfidence: 0.6, ambiguousMargin: 0.1 };

function page(over: Partial<ExtractedPage>): ExtractedPage {
  return {
    requestedUrl: 'https://acme.example',
    finalUrl: 'https://acme.example',
    host: 'acme.example',
    httpStatus: 200,
    title: 'Acme Dental',
    visibleTextLength: 500,
    visibleTextSample: 'acme dental manchester',
    scriptCount: 1,
    hasEmptyAppRoot: false,
    phones: [],
    emails: [],
    contactFormUrls: [],
    structured: [],
    sameOriginLinks: [],
    legalText: null,
    ...over,
  };
}

const ctx: EnrichmentContext = {
  businessName: 'Acme Dental',
  phone: '0161 496 0000',
  formattedAddress: '1 Main St, Manchester',
  city: 'Manchester',
  country: 'GB',
};

const cand = (url: string): Candidate => ({ url, discoverySource: 'manual' });

describe('scoreCandidate', () => {
  it('VERIFIES on an exact phone match and emits official_* facts', () => {
    const v = scoreCandidate(cand('https://acme.example'), [page({ phones: ['+441614960000'] })], ctx, OPTS);
    expect(v.decision).toBe('VERIFIED');
    expect(v.signals.some((s) => s.signalType === 'exact_phone' && s.strong)).toBe(true);
    expect(v.facts.map((f) => f.factType)).toEqual(expect.arrayContaining(['official_domain', 'official_website_url']));
  });

  it('REJECTS a directory/social host', () => {
    const v = scoreCandidate(cand('https://facebook.com/acme'), [page({ host: 'facebook.com', finalUrl: 'https://facebook.com/acme' })], ctx, OPTS);
    expect(v.decision).toBe('REJECTED');
    expect(v.isDirectory).toBe(true);
  });

  it('routes weak name-tokens-only to AMBIGUOUS (never VERIFIED)', () => {
    const v = scoreCandidate(cand('https://acme.example'), [page({ visibleTextSample: 'acme dental manchester clinic' })], ctx, OPTS);
    expect(v.decision).toBe('AMBIGUOUS');
    expect(v.signals.every((s) => !s.strong)).toBe(true);
  });

  it('flags a client-rendered shell as browserRequired', () => {
    const v = scoreCandidate(
      cand('https://acme.example'),
      [page({ visibleTextLength: 10, visibleTextSample: '', hasEmptyAppRoot: true, scriptCount: 6 })],
      ctx,
      OPTS,
    );
    expect(v.decision).toBe('REJECTED');
    expect(v.browserRequired).toBe(true);
  });

  it('captures a branch/location page as official_location_page_url', () => {
    const home = page({ phones: ['+441614960000'] });
    const branch = page({
      finalUrl: 'https://acme.example/locations/manchester',
      requestedUrl: 'https://acme.example/locations/manchester',
      visibleTextSample: '1 main st manchester',
      phones: ['+441614960000'],
    });
    const v = scoreCandidate(cand('https://acme.example'), [home, branch], ctx, OPTS);
    expect(v.decision).toBe('VERIFIED');
    expect(v.facts.some((f) => f.factType === 'official_location_page_url')).toBe(true);
  });
});

function verified(host: string, confidence: number): CandidateVerification {
  return {
    requestedUrl: `https://${host}`,
    finalUrl: `https://${host}`,
    host,
    httpStatus: 200,
    discoverySource: 'manual',
    isDirectory: false,
    decision: 'VERIFIED',
    confidence,
    rejectedReason: null,
    signals: [],
    facts: [],
    browserRequired: false,
  };
}

describe('decideOutcome', () => {
  it('picks a single verified winner', () => {
    expect(decideOutcome([verified('a.example', 0.9)], OPTS).outcome).toBe('VERIFIED');
  });
  it('flags two plausible different-domain winners as AMBIGUOUS', () => {
    const d = decideOutcome([verified('a.example', 0.9), verified('b.example', 0.85)], OPTS);
    expect(d.outcome).toBe('AMBIGUOUS');
    expect(d.winner).toBeNull();
  });
  it('returns NO_VERIFIED_CANDIDATE when all are rejected', () => {
    const rejected = { ...verified('a.example', 0), decision: 'REJECTED' as const };
    expect(decideOutcome([rejected], OPTS).outcome).toBe('NO_VERIFIED_CANDIDATE');
  });
  it('returns BROWSER_REQUIRED when a candidate needs a browser', () => {
    const br = { ...verified('a.example', 0), decision: 'REJECTED' as const, browserRequired: true };
    expect(decideOutcome([br], OPTS).outcome).toBe('BROWSER_REQUIRED');
  });
  it('returns NO_CANDIDATE for an empty list', () => {
    expect(decideOutcome([], OPTS).outcome).toBe('NO_CANDIDATE');
  });
});
