/**
 * Fixtures for mock enrichment (local dev + the end-to-end demo). Candidate URLs
 * per Place ID and canned HTML per URL. The HTML contains business identity/contact
 * signals matching the mock businesses so verification is deterministic offline.
 */

function dentalSite(name: string, phone: string, city: string, address: string): string {
  return `<!doctype html><html><head><title>${name} — ${city} Dentist</title></head>
  <body>
    <header><h1>${name}</h1></header>
    <main>
      <p>Welcome to ${name}, an independent dental practice in ${city}.</p>
      <p>Address: ${address}</p>
      <p>Call us: <a href="tel:${phone.replace(/\s/g, '')}">${phone}</a></p>
      <p>Email: <a href="mailto:hello@${name.toLowerCase().replace(/[^a-z]/g, '')}.example">hello@${name.toLowerCase().replace(/[^a-z]/g, '')}.example</a></p>
      <a href="/contact">Contact us</a>
      <script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Dentist',
        name,
        telephone: phone,
        address: { '@type': 'PostalAddress', streetAddress: address, addressLocality: city },
      })}</script>
    </main>
    <footer>${name} Ltd — ${city}</footer>
  </body></html>`;
}

// Place ID (from mock collection) → candidate website URLs.
export const mockEnrichmentCandidates = new Map<string, string[]>([
  ['mock-0002', ['https://riversidefamilydentistry.example']],
  ['mock-0003', ['https://citycentreortho.example']],
]);

// Candidate URL → canned HTML (matching each lead's collected phone/name).
export const mockEnrichmentPages = new Map<string, string>([
  [
    'https://riversidefamilydentistry.example',
    dentalSite('Riverside Family Dentistry', '+44 161 496 0002', 'Manchester', '5 Deansgate'),
  ],
  [
    'https://citycentreortho.example',
    dentalSite('City Centre Orthodontics', '0161 496 0003', 'Manchester', '88 Piccadilly'),
  ],
]);
