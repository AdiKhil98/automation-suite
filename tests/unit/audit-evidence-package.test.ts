import { describe, expect, it } from 'vitest';
import {
  buildEvidencePackage,
  buildReviewerPackage,
  canonicalizeUrl,
} from '../../src/domain/audit/evidence-package.js';
import { evidenceRef, PRIMARY_URL, testPackage } from './helpers/audit-fixtures.js';

const limits = { maxEvidence: 5, maxSecondaryPages: 1, maxEvidenceChars: 20, maxImages: 2 };

function build(evidence: ReturnType<typeof evidenceRef>[]) {
  return buildEvidencePackage({
    leadId: 'lead-1',
    captureRunId: 'cap-1',
    facts: { businessName: 'Test', category: null, city: null, officialDomain: null },
    primaryUrl: PRIMARY_URL,
    evidence,
    images: [],
    versions: { extractor: 't', emulation: 't', pageSelection: 't' },
    limits,
  });
}

describe('buildEvidencePackage', () => {
  it('preserves original evidence ids (model cites real DB rows)', () => {
    const e = evidenceRef();
    expect(build([e]).evidence[0]?.id).toBe(e.id);
  });

  it('excludes console_error noise', () => {
    const pkg = build([evidenceRef({ evidenceType: 'console_error' }), evidenceRef()]);
    expect(pkg.evidence.every((e) => e.evidenceType !== 'console_error')).toBe(true);
  });

  it('dedups identical evidence values', () => {
    const a = evidenceRef({ evidenceType: 'cta', normalizedValue: 'book now' });
    const b = evidenceRef({ evidenceType: 'cta', normalizedValue: 'book now' });
    expect(build([a, b]).evidence).toHaveLength(1);
  });

  it('caps total evidence and truncates values', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      evidenceRef({ evidenceType: 'heading', normalizedValue: `h${String(i)}`, extractedValue: 'x'.repeat(100) }),
    );
    const pkg = build(many);
    expect(pkg.evidence.length).toBeLessThanOrEqual(limits.maxEvidence);
    expect(pkg.evidence[0]?.extractedValue?.length).toBeLessThanOrEqual(limits.maxEvidenceChars);
  });

  it('bounds distinct secondary pages', () => {
    const pkg = build([
      evidenceRef({ sourceUrl: 'https://www.testdental.example/a', normalizedValue: 'a' }),
      evidenceRef({ sourceUrl: 'https://www.testdental.example/b', normalizedValue: 'b' }),
      evidenceRef({ sourceUrl: 'https://www.testdental.example/c', normalizedValue: 'c' }),
    ]);
    const secondary = new Set(
      pkg.evidence.map((e) => canonicalizeUrl(e.sourceUrl)).filter((u) => u !== canonicalizeUrl(PRIMARY_URL)),
    );
    expect(secondary.size).toBeLessThanOrEqual(limits.maxSecondaryPages);
  });

  it('prioritizes primary-page conversion evidence when capping', () => {
    const filler = Array.from({ length: 5 }, (_, i) =>
      evidenceRef({ evidenceType: 'image_alt', sourceUrl: 'https://www.testdental.example/about', normalizedValue: `alt${String(i)}` }),
    );
    const cta = evidenceRef({ evidenceType: 'cta', normalizedValue: 'unique-book-now' });
    const pkg = build([...filler, cta]);
    expect(pkg.evidence.some((e) => e.id === cta.id)).toBe(true);
  });

  it('collects allowed canonical URLs from primary + selected evidence', () => {
    const pkg = testPackage();
    expect(pkg.allowedCanonicalUrls.has(canonicalizeUrl(PRIMARY_URL) as string)).toBe(true);
  });
});

describe('buildReviewerPackage', () => {
  it('keeps only evidence referenced by the proposed findings', () => {
    const pkg = testPackage();
    const keep = pkg.evidence[0]?.id ?? '';
    const reviewer = buildReviewerPackage(pkg, new Set([keep]));
    expect(reviewer.evidence.map((e) => e.id)).toEqual([keep]);
    expect(reviewer.images).toEqual(pkg.images); // context screenshots stay
  });
});

describe('canonicalizeUrl', () => {
  it('strips hash, query, trailing slash and lowercases host', () => {
    expect(canonicalizeUrl('https://WWW.Example.COM/Path/?q=1#top')).toBe('https://www.example.com/Path');
  });
  it('returns null for invalid URLs', () => {
    expect(canonicalizeUrl('not a url')).toBeNull();
  });
});
