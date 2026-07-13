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
