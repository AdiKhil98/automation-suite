import { describe, expect, it } from 'vitest';
import { deriveCompetitorObservations } from '../../../src/domain/competitor/evidence-rules.js';
import { type CapturedPageInput } from '../../../src/domain/competitor/evidence-types.js';

const RICH_HOME = `<!doctype html><html lang="de"><head>
  <link rel="alternate" hreflang="de" href="https://competitor-a.de/de">
  <link rel="alternate" hreflang="en" href="https://competitor-a.de/en">
</head><body>
  <nav><a href="https://competitor-a.de/kontakt">Kontakt</a><a href="https://competitor-a.de/leistungen">Leistungen</a></nav>
  <h1>Zahnarztpraxis Berlin</h1>
  <a class="btn" href="https://book.competitor-a.de/termin">Termin buchen</a>
  <a href="tel:+49301234567">Anrufen</a>
  <a href="https://wa.me/49301234567">WhatsApp</a>
  <h2>Unsere Leistungen</h2>
  <address>Hauptstrasse 1, 10115 Berlin</address>
  <div>Öffnungszeiten: Mo-Fr 9-17 Uhr</div>
  <h2>Häufige Fragen (FAQ)</h2>
  <div class="sticky-contact" style="position:fixed;bottom:0"><a href="tel:+49301234567">Jetzt anrufen</a></div>
</body></html>`;

function page(profile: 'desktop' | 'mobile', html = RICH_HOME): CapturedPageInput {
  return {
    requestedUrl: 'https://competitor-a.de',
    finalUrl: 'https://competitor-a.de',
    role: 'homepage',
    profile,
    ok: true,
    html,
    errorKinds: [],
  };
}

describe('deriveCompetitorObservations', () => {
  const obs = deriveCompetitorObservations('cand-1', 'competitor-a.de', [page('desktop'), page('mobile')]);
  const find = (cat: string, profile?: string) => obs.find((o) => o.evidenceCategory === cat && (!profile || o.profile === profile));

  it('detects a booking CTA at HIGH confidence via a structured anchor', () => {
    const b = find('BOOKING_CTA_VISIBLE');
    expect(b?.confidence).toBe('HIGH');
    expect(b?.observationKind).toBe('DIRECT_OBSERVATION');
  });

  it('detects a click-to-call phone control (tel:) at HIGH', () => {
    expect(find('PHONE_VISIBLE')?.confidence).toBe('HIGH');
  });

  it('detects a WhatsApp/direct-message control', () => {
    expect(find('WHATSAPP_OR_DIRECT_MESSAGE_VISIBLE')?.confidence).toBe('HIGH');
  });

  it('detects a structured postal address as LOCATION at HIGH', () => {
    expect(find('LOCATION_VISIBLE')?.confidence).toBe('HIGH');
  });

  it('detects opening hours (text) at MEDIUM', () => {
    expect(find('OPENING_HOURS_VISIBLE')?.confidence).toBe('MEDIUM');
  });

  it('detects services and FAQ sections', () => {
    expect(find('SERVICE_INFORMATION_VISIBLE')).toBeTruthy();
    expect(find('FAQ_CONTENT_VISIBLE')).toBeTruthy();
  });

  it('detects multi-language support via hreflang alternates', () => {
    expect(find('LANGUAGE_SUPPORT_VISIBLE')?.confidence).toBe('HIGH');
  });

  it('detects a mobile sticky contact control (mobile profile only, deterministic interpretation)', () => {
    const s = find('MOBILE_STICKY_CONTACT_CONTROL', 'mobile');
    expect(s?.observationKind).toBe('DETERMINISTIC_INTERPRETATION');
    expect(find('MOBILE_STICKY_CONTACT_CONTROL', 'desktop')).toBeUndefined();
  });

  it('computes contact-path depth 0 when contact info is on the homepage', () => {
    const d = find('CONTACT_PATH_DEPTH');
    expect(d?.numericValue).toBe(0);
    expect(d?.observationKind).toBe('DETERMINISTIC_INTERPRETATION');
  });

  it('computes mobile navigation depth 1 when contact is a top-level nav link', () => {
    expect(find('MOBILE_NAVIGATION_DEPTH', 'mobile')?.numericValue).toBe(1);
  });

  it('retains source URL and a reproducible selector for observations', () => {
    const p = find('PHONE_VISIBLE');
    expect(p?.sourcePageUrl).toBe('https://competitor-a.de');
    expect(p?.selector).toBe('a[href^=tel:]');
  });

  it('classifies an absent mobile sticky control as LOW + AMBIGUOUS (withheld, never asserted absent)', () => {
    const bare = `<html><body><nav><a href="/kontakt">Kontakt</a></nav><h1>Praxis</h1></body></html>`;
    const o = deriveCompetitorObservations('c', 'x.de', [page('mobile', bare)]);
    const s = o.find((x) => x.evidenceCategory === 'MOBILE_STICKY_CONTACT_CONTROL');
    expect(s?.confidence).toBe('LOW');
    expect(s?.withholdingReason).toBe('AMBIGUOUS');
  });

  it('never emits an UNSUPPORTED_INFERENCE observation (no performance/volume/ranking inference)', () => {
    expect(obs.every((o) => o.observationKind !== 'UNSUPPORTED_INFERENCE')).toBe(true);
  });

  it('produces identical observations for identical HTML (deterministic)', () => {
    const again = deriveCompetitorObservations('cand-1', 'competitor-a.de', [page('desktop'), page('mobile')]);
    expect(JSON.stringify(again)).toBe(JSON.stringify(obs));
  });

  it('emits at most one observation per (category, profile)', () => {
    const keys = obs.map((o) => `${o.evidenceCategory}|${o.profile}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
