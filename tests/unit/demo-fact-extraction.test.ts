import { describe, expect, it } from 'vitest';
import { extractDemoFacts, type EvidenceLike } from '../../src/domain/demo/fact-extraction.js';

const ev = (evidenceType: string, extractedValue: string, sourceUrl = 'https://x.example/'): EvidenceLike => ({ evidenceType, extractedValue, sourceUrl, normalizedValue: extractedValue.toLowerCase() });
const byType = (facts: ReturnType<typeof extractDemoFacts>, t: string) => facts.find((f) => f.factType === t);

describe('extractDemoFacts', () => {
  it('extracts phone and email from tel/mailto evidence', () => {
    const facts = extractDemoFacts([ev('tel', '+49 30 1234567'), ev('mailto', 'praxis@zahnaerzte-am-ufer.de')]);
    expect(byType(facts, 'phone')?.value).toBe('+49 30 1234567');
    expect(byType(facts, 'phone')?.normalizedValue).toBe('+49301234567');
    expect(byType(facts, 'contact_email')?.value).toBe('praxis@zahnaerzte-am-ufer.de');
  });

  it('prefers JSON-LD for phone/email/address/hours when present', () => {
    const ld = JSON.stringify({ '@type': 'Dentist', telephone: '+49 30 999', email: 'a@b.de', address: { streetAddress: 'Uferstr. 5', postalCode: '10997', addressLocality: 'Berlin' }, openingHours: ['Mo-Fr 08:00-18:00', 'Sa 09:00-12:00'] });
    const facts = extractDemoFacts([ev('structured_data', ld)]);
    expect(byType(facts, 'phone')?.value).toBe('+49 30 999');
    expect(byType(facts, 'formatted_address')?.value).toBe('Uferstr. 5, 10997, Berlin');
    expect(byType(facts, 'opening_hours')?.value).toContain('Mo-Fr 08:00-18:00');
  });

  it('extracts services from service-keyword nav labels/headings, ignoring generic nav', () => {
    const facts = extractDemoFacts([
      ev('nav_label', 'Home'), ev('nav_label', 'Prophylaxe'), ev('heading', 'Implantologie'),
      ev('nav_label', 'Kontakt'), ev('heading', 'Professionelle Zahnreinigung'), ev('nav_label', 'Impressum'),
    ]);
    const services = byType(facts, 'services')?.value ?? '';
    expect(services).toContain('Prophylaxe');
    expect(services).toContain('Implantologie');
    expect(services).toContain('Professionelle Zahnreinigung');
    expect(services).not.toContain('Home');
    expect(services).not.toContain('Kontakt');
  });

  it('extracts contact and booking URLs from link paths', () => {
    const facts = extractDemoFacts([
      ev('link', 'https://zahnaerzte-am-ufer.de/kontakt'),
      ev('link', 'https://zahnaerzte-am-ufer.de/termin-buchen'),
      ev('link', 'https://zahnaerzte-am-ufer.de/leistungen'),
    ]);
    expect(byType(facts, 'contact_form_url')?.value).toContain('/kontakt');
    expect(byType(facts, 'booking_url')?.value).toContain('/termin-buchen');
  });

  it('detects a third-party booking platform by host (e.g. Doctolib)', () => {
    const facts = extractDemoFacts([ev('link', 'https://www.doctolib.de/zahnarztpraxis/berlin/zahnaerzte-am-ufer')]);
    expect(byType(facts, 'booking_url')?.value).toContain('doctolib.de');
  });

  it('extracts a German address from footer text', () => {
    const facts = extractDemoFacts([ev('footer_legal', 'Praxis · Uferstraße 12, 10997 Berlin · Tel 030 123')]);
    expect(byType(facts, 'formatted_address')?.value).toMatch(/10997 Berlin/);
  });

  it('returns nothing usable from empty/uninformative evidence', () => {
    expect(extractDemoFacts([ev('title', 'Home'), ev('lang', 'de')])).toHaveLength(0);
  });

  it('produces one fact per type and marks sourceUrl', () => {
    const facts = extractDemoFacts([ev('tel', '+49 1'), ev('tel', '+49 2')]);
    expect(facts.filter((f) => f.factType === 'phone')).toHaveLength(1);
    expect(byType(facts, 'phone')?.sourceUrl).toBe('https://x.example/');
  });

  it('tolerates truncated/invalid JSON-LD without throwing', () => {
    expect(() => extractDemoFacts([ev('structured_data', '{"@type":"Dentist","telephone":"+49 30 9')])).not.toThrow();
  });
});
