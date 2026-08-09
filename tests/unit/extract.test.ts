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
  it('does not treat a contact page as a booking route', () => {
    // Existing contact/about harvesting is unchanged; no booking route on this page.
    expect(page.bookingPathLinks).toHaveLength(0);
  });
  it('parses JSON-LD business + legal footer', () => {
    expect(page.structured[0]?.telephone).toBe('+44 161 496 0000');
    expect(page.legalText).toContain('Acme Dental Ltd');
  });
  it('harvests a same-origin booking route into bookingPathLinks (never sameOriginLinks)', () => {
    const p = extractPage(
      `<html><body>
        <a href="/contact">Contact</a>
        <a href="/book">Book online</a>
        <a href="https://booking.uk.hsone.app/soe/new/X">Book with our system</a>
       </body></html>`,
      'https://acmedental.example',
      'https://acmedental.example',
      200,
    );
    // Same-origin /book is eligible for a bounded booking secondary page.
    expect(p.bookingPathLinks.some((l) => l.href.endsWith('/book'))).toBe(true);
    // The external provider link is NOT harvested for capture — it is never crawled.
    expect(p.bookingPathLinks.some((l) => l.href.includes('hsone.app'))).toBe(false);
    // Booking links never leak into the enrichment same-origin crawl set.
    expect(p.sameOriginLinks.some((l) => l.href.endsWith('/book'))).toBe(false);
    // Existing contact harvesting still works.
    expect(p.sameOriginLinks.some((l) => l.href.endsWith('/contact'))).toBe(true);
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
