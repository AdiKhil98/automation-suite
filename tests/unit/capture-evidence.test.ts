import { describe, expect, it } from 'vitest';
import {
  extractCaptureEvidence,
  normalizedEvidenceFingerprint,
  rawDomHash,
} from '../../src/domain/capture/capture-evidence.js';
import { type RenderedPage } from '../../src/domain/capture/capture-types.js';

function page(html: string, overflow = false): RenderedPage {
  return {
    requestedUrl: 'https://acme.example',
    finalUrl: 'https://acme.example',
    canonicalUrl: null,
    httpStatus: 200,
    profile: 'desktop',
    ok: true,
    html,
    loadMs: 5,
    hasHorizontalOverflow: overflow,
    screenshots: [],
    errors: [],
  };
}

const HTML = `<html lang="en-GB"><head><title>Acme Dental</title><meta name="description" content="Manchester dentist"></head>
<body><nav><a href="/contact">Contact</a></nav><h1>Acme Dental</h1>
<button>Book now</button><a href="tel:+441614960000">Call</a><a href="mailto:hi@acme.example">Email</a>
<footer>Acme Dental Ltd</footer></body></html>`;

describe('extractCaptureEvidence', () => {
  const items = extractCaptureEvidence(page(HTML, true));
  const types = new Set(items.map((i) => i.evidenceType));

  it('extracts deterministic evidence types', () => {
    for (const t of ['title', 'meta_description', 'lang', 'heading', 'nav_label', 'cta', 'tel', 'mailto', 'footer_legal']) {
      expect(types.has(t as never), t).toBe(true);
    }
  });
  it('records horizontal overflow as a neutral observation', () => {
    expect(items.some((i) => i.evidenceType === 'horizontal_overflow' && i.extractedValue === 'true')).toBe(true);
  });
});

const CTA_HTML = `<html><head><title>Clinic</title></head><body>
<nav><a href="/contact/">Contact us</a></nav>
<a href="/contact/">Book appointment</a>
<button>Book now</button>
<div role="button">Reserve your visit</div>
<form action="/enquiry"><input name="q" /><button type="submit">Send enquiry</button></form>
<a href="https://www.facebook.com/clinic">Facebook</a>
<a href="tel:+441234567890">Call us</a>
</body></html>`;

describe('extractCaptureEvidence — interactive control text + destination', () => {
  const items = extractCaptureEvidence(page(CTA_HTML));
  const ctas = items.filter((i) => i.evidenceType === 'cta');
  const find = (text: string) => ctas.find((c) => c.extractedValue.startsWith(`text=${text} `));

  it('preserves BOTH anchor text and href for a link-styled CTA', () => {
    const cta = find('Book appointment');
    expect(cta).toBeDefined();
    expect(cta?.extractedValue).toContain('text=Book appointment');
    expect(cta?.extractedValue).toContain('href=/contact/');
    expect(cta?.extractedValue).toContain('tag=a');
    expect(cta?.normalizedValue).toBe('book appointment');
  });
  it('preserves button text', () => {
    expect(find('Book now')?.extractedValue).toContain('tag=button');
  });
  it('preserves role=button text', () => {
    expect(find('Reserve your visit')?.extractedValue).toContain('text=Reserve your visit');
  });
  it('preserves a form submit control text with the form action', () => {
    const submit = find('Send enquiry');
    expect(submit?.extractedValue).toContain('tag=submit');
    expect(submit?.extractedValue).toContain('href=/enquiry');
  });
  it('keeps generic "Contact us" as ordinary nav/link + CTA evidence (destination /contact/)', () => {
    expect(items.some((i) => i.evidenceType === 'nav_label' && i.extractedValue === 'Contact us')).toBe(true);
    expect(find('Contact us')?.extractedValue).toContain('href=/contact/');
  });
  it('backward compatible: links keep a bare href, tel is captured separately, tel/mailto are not CTAs', () => {
    const link = items.find((i) => i.evidenceType === 'link');
    expect(link?.extractedValue).toBe('https://www.facebook.com/clinic'); // bare href, unchanged shape
    expect(items.some((i) => i.evidenceType === 'tel')).toBe(true);
    expect(ctas.some((c) => c.extractedValue.includes('tel:'))).toBe(false);
  });
});

describe('fingerprints', () => {
  it('normalized fingerprint is stable and ignores volatile values', () => {
    const a = normalizedEvidenceFingerprint(extractCaptureEvidence(page(HTML)));
    const withNonce = HTML.replace('<h1>', '<h1 data-nonce="nonce-abc123def456">');
    const b = normalizedEvidenceFingerprint(extractCaptureEvidence(page(withNonce)));
    expect(a).toBe(b);
  });
  it('raw DOM hash changes when the DOM changes', () => {
    expect(rawDomHash('<a>')).not.toBe(rawDomHash('<b>'));
  });
});
