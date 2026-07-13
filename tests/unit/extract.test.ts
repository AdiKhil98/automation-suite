import { describe, expect, it } from 'vitest';
import { extractPage } from '../../src/domain/enrichment/extract.js';

const html = `<!doctype html><html><head><title>Acme Dental — Manchester</title></head>
<body>
  <h1>Acme Dental</h1>
  <p>Call <a href="tel:+441614960000">0161 496 0000</a> or email
     <a href="mailto:hello@acmedental.example">hello@acmedental.example</a></p>
  <p>Reach us at info@acmedental.example too.</p>
  <a href="/contact">Contact us</a>
  <a href="https://facebook.com/acme">Facebook</a>
  <form action="/contact"><input name="message" /></form>
  <script type="application/ld+json">${JSON.stringify({
    '@type': 'Dentist',
    name: 'Acme Dental',
    telephone: '+44 161 496 0000',
    address: { streetAddress: '1 Main St', addressLocality: 'Manchester' },
  })}</script>
  <footer>Acme Dental Ltd</footer>
</body></html>`;

describe('extractPage', () => {
  const page = extractPage(html, 'https://acmedental.example', 'https://acmedental.example', 200);

  it('pulls title and host', () => {
    expect(page.title).toContain('Acme Dental');
    expect(page.host).toBe('acmedental.example');
  });
  it('extracts mailto + visible emails', () => {
    expect(page.emails).toContain('hello@acmedental.example');
    expect(page.emails).toContain('info@acmedental.example');
  });
  it('extracts tel: phone', () => {
    expect(page.phones).toContain('+441614960000');
  });
  it('finds same-origin contact link and contact form', () => {
    expect(page.sameOriginLinks.some((l) => l.href.endsWith('/contact'))).toBe(true);
    expect(page.contactFormUrls.some((u) => u.endsWith('/contact'))).toBe(true);
  });
  it('parses JSON-LD business + legal footer', () => {
    expect(page.structured[0]?.telephone).toBe('+44 161 496 0000');
    expect(page.legalText).toContain('Acme Dental Ltd');
  });
  it('detects a client-rendered shell', () => {
    const shell = extractPage(
      '<html><body><div id="root"></div><script src="a.js"></script><script src="b.js"></script><script src="c.js"></script><script src="d.js"></script><script src="e.js"></script></body></html>',
      'https://x.example',
      'https://x.example',
      200,
    );
    expect(shell.hasEmptyAppRoot).toBe(true);
    expect(shell.visibleTextLength).toBeLessThan(200);
  });
});
