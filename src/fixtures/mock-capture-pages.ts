import { type MockPageSpec } from '../integrations/capture/mock-capture.js';

function dentalSite(name: string, phone: string, city: string): string {
  return `<!doctype html><html lang="en-GB"><head><title>${name} — ${city} Dentist</title>
  <meta name="description" content="${name}, dental practice in ${city}."></head>
  <body>
    <nav><a href="/contact">Contact</a><a href="/about">About</a><a href="/services">Services</a></nav>
    <h1>${name}</h1>
    <p>Welcome to ${name} in ${city}. Book your appointment today.</p>
    <p>Call <a href="tel:${phone.replace(/\s/g, '')}">${phone}</a></p>
    <a class="button" href="/book">Book online</a>
    <footer>${name} Ltd — ${city}</footer>
  </body></html>`;
}

/** Canned capture pages for the mock provider (offline end-to-end demo + tests). */
export const mockCapturePages = new Map<string, MockPageSpec>([
  ['https://brightsmiledental.example', { html: dentalSite('Bright Smile Dental Practice', '0161 496 0001', 'Manchester') }],
  ['https://www.brightsmiledental.example', { html: dentalSite('Bright Smile Dental Practice', '0161 496 0001', 'Manchester') }],
  ['https://riversidefamilydentistry.example', { html: dentalSite('Riverside Family Dentistry', '0161 496 0002', 'Manchester') }],
  ['https://citycentreortho.example', { html: dentalSite('City Centre Orthodontics', '0161 496 0003', 'Manchester') }],
]);
