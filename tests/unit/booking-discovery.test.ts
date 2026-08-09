import { describe, expect, it } from 'vitest';
import { discoverBooking } from '../../src/domain/deterministic-finding/booking-discovery.js';
import { type DeterministicEvidenceRow } from '../../src/domain/deterministic-finding/evidence-row.js';
import { type CaptureEvidenceType } from '../../src/domain/capture/capture-evidence.js';

const LEAD = 'lead-1';
const RUN = 'run-1';
const AWARE = 'cap-pages-2';

function ev(id: string, type: CaptureEvidenceType, over: Partial<DeterministicEvidenceRow> = {}): DeterministicEvidenceRow {
  return {
    id,
    leadId: LEAD,
    captureRunId: RUN,
    evidenceType: type,
    sourceUrl: 'https://whitgift.example/',
    profile: 'desktop',
    extractedValue: null,
    normalizedValue: null,
    ...over,
  };
}

// A minimal "captured a page, no booking anywhere" baseline (phone/title only).
const TEL = ev('e-tel', 'tel', { extractedValue: '+44 20 1234 5678', normalizedValue: '+442012345678' });
const TITLE = ev('e-title', 'title', { extractedValue: 'Whitgift Dental', normalizedValue: 'whitgift dental' });

function linkRow(id: string, url: string, host: string): DeterministicEvidenceRow {
  return ev(id, 'link', { extractedValue: url, normalizedValue: host });
}

describe('bounded booking discovery — provider hosts', () => {
  it('detects the HSOE (hsone) booking URL', () => {
    const row = linkRow('e', 'https://booking.uk.hsone.app/soe/new/Whitgift%20Dental?pid=UKLAL01', 'booking.uk.hsone.app');
    const r = discoverBooking([TEL, row], AWARE);
    expect(r.status).toBe('ONLINE_BOOKING_FOUND');
    expect(r.signals.map((s) => s.evidenceId)).toContain('e');
  });

  it('detects CareStack', () => {
    const row = linkRow('e', 'https://whitgift.carestack.com/book', 'whitgift.carestack.com');
    expect(discoverBooking([TEL, row], AWARE).status).toBe('ONLINE_BOOKING_FOUND');
  });

  it('detects Dentalhub', () => {
    const row = linkRow('e', 'https://portal.dentalhub.com/patient', 'portal.dentalhub.com');
    const r = discoverBooking([TEL, row], AWARE);
    expect(r.status).toBe('ONLINE_BOOKING_FOUND');
    expect(r.signals[0]?.reason).toBe('provider_host');
  });

  it('detects Dentally', () => {
    const row = linkRow('e', 'https://whitgift.dentally.co/portal', 'whitgift.dentally.co');
    expect(discoverBooking([TEL, row], AWARE).status).toBe('ONLINE_BOOKING_FOUND');
  });

  it('detects Zesty', () => {
    const row = linkRow('e', 'https://www.zesty.co.uk/practice/whitgift', 'www.zesty.co.uk');
    expect(discoverBooking([TEL, row], AWARE).status).toBe('ONLINE_BOOKING_FOUND');
  });
});

describe('bounded booking discovery — keywords', () => {
  it('detects a booking CTA by keyword', () => {
    const cta = ev('e-cta', 'cta', { extractedValue: 'Book online', normalizedValue: 'book online' });
    expect(discoverBooking([TEL, cta], AWARE).status).toBe('ONLINE_BOOKING_FOUND');
  });

  it('detects a consultation nav label by keyword', () => {
    const nav = ev('e-nav', 'nav_label', { extractedValue: 'Request a consultation', normalizedValue: 'request a consultation' });
    const r = discoverBooking([TEL, nav], AWARE);
    expect(r.status).toBe('ONLINE_BOOKING_FOUND');
    expect(r.signals[0]?.reason).toBe('keyword');
  });
});

// A CTA row as produced by the capture extractor: `text=<t> href=<d> tag=<x>`, normalized to text.
function ctaRow(id: string, text: string, href: string, tag = 'a'): DeterministicEvidenceRow {
  return ev(id, 'cta', { extractedValue: `text=${text} href=${href} tag=${tag}`, normalizedValue: text.toLowerCase() });
}

describe('bounded booking discovery — destination decides direct vs intent', () => {
  it('"Book appointment" → /contact/ is booking INTENT, not direct online booking', () => {
    const cta = ctaRow('e-cta', 'Book appointment', '/contact/');
    const r = discoverBooking([TEL, cta], AWARE);
    expect(r.status).toBe('NO_ONLINE_BOOKING');
    expect(r.signals).toEqual([]);
    expect(r.intentSignals).toHaveLength(1);
    expect(r.intentSignals[0]?.reason).toBe('booking_intent');
  });

  it('"Book online" → external provider (HSOE) is DIRECT online booking', () => {
    const cta = ctaRow('e-cta', 'Book online', 'https://booking.uk.hsone.app/soe/new/X');
    const r = discoverBooking([TEL, cta], AWARE);
    expect(r.status).toBe('ONLINE_BOOKING_FOUND');
    expect(r.signals[0]?.reason).toBe('provider_host');
  });

  it('"Book online" → CareStack is DIRECT online booking', () => {
    const cta = ctaRow('e-cta', 'Book online', 'https://clinic.carestack.com/book');
    expect(discoverBooking([TEL, cta], AWARE).signals[0]?.reason).toBe('provider_host');
  });

  it('a dedicated /book-online route (destination keyword) is DIRECT (booking_route)', () => {
    const cta = ctaRow('e-cta', 'Book appointment', 'https://clinic.example/book-online/');
    const r = discoverBooking([TEL, cta], AWARE);
    expect(r.status).toBe('ONLINE_BOOKING_FOUND');
    expect(r.signals[0]?.reason).toBe('booking_route');
  });

  it('a generic "Contact us" CTA to /contact/ is neither booking nor booking-intent', () => {
    const cta = ctaRow('e-cta', 'Contact us', '/contact/');
    const r = discoverBooking([TEL, cta], AWARE);
    expect(r.status).toBe('NO_ONLINE_BOOKING');
    expect(r.signals).toEqual([]);
    expect(r.intentSignals).toEqual([]);
  });
});

describe('bounded booking discovery — keyword must be word-boundary anchored', () => {
  it('a Facebook link is NOT a booking signal ("book" must not match inside "facebook")', () => {
    const fb = linkRow('e-fb', 'https://www.facebook.com/MayfieldDentalSouthCroydon', 'www.facebook.com');
    const r = discoverBooking([TEL, TITLE, fb], AWARE);
    expect(r.status).toBe('NO_ONLINE_BOOKING');
    expect(r.signals).toEqual([]);
  });

  it('a real /book route link is still detected', () => {
    const link = linkRow('e-book', 'https://clinic.example/book-online/', 'clinic.example');
    expect(discoverBooking([TEL, link], AWARE).status).toBe('ONLINE_BOOKING_FOUND');
  });
});

describe('bounded booking discovery — external link detected but never crawled', () => {
  it('records the external provider link as a signal (Layer 1) without listing it as a page to fetch', () => {
    // A cross-origin provider link appears as ordinary `link` evidence — it is DETECTED here.
    const external = linkRow('e', 'https://booking.uk.hsone.app/soe/new/X', 'booking.uk.hsone.app');
    const r = discoverBooking([TEL, external], AWARE);
    expect(r.status).toBe('ONLINE_BOOKING_FOUND');
    // Discovery reports only the captured page scope; the external host is never a captured page URL.
    expect(r.searchedScope.pageUrls).toEqual(['https://whitgift.example/']);
    expect(r.searchedScope.pageUrls).not.toContain('booking.uk.hsone.app');
  });
});

describe('bounded booking discovery — the critical absence rule', () => {
  it('NO_ONLINE_BOOKING only when the capture is booking-aware and pages were captured', () => {
    const r = discoverBooking([TEL, TITLE], AWARE);
    expect(r.status).toBe('NO_ONLINE_BOOKING');
    expect(r.searchedScope.bookingAware).toBe(true);
    expect(r.incompleteReason).toBeNull();
  });

  it('UNKNOWN (not ABSENT) when the capture is not booking-aware', () => {
    const r = discoverBooking([TEL, TITLE], 'cap-pages-1');
    expect(r.status).toBe('UNKNOWN');
    expect(r.incompleteReason).toBe('capture_not_booking_aware');
  });

  it('UNKNOWN when the policy version is unknown/null', () => {
    expect(discoverBooking([TEL, TITLE], null).status).toBe('UNKNOWN');
  });

  it('UNKNOWN when there is no captured evidence to search', () => {
    const r = discoverBooking([], AWARE);
    expect(r.status).toBe('UNKNOWN');
    expect(r.incompleteReason).toBe('no_captured_pages');
  });

  it('a positive signal is honored even on a non-booking-aware capture (booking disproves absence)', () => {
    const cta = ev('e-cta', 'cta', { extractedValue: 'Book appointment', normalizedValue: 'book appointment' });
    expect(discoverBooking([TEL, cta], 'cap-pages-1').status).toBe('ONLINE_BOOKING_FOUND');
  });

  it('always reports the searched scope for auditability', () => {
    const r = discoverBooking([TEL, TITLE], AWARE);
    expect(r.searchedScope.evidenceTypesScanned).toEqual(['cta', 'link', 'nav_label', 'form']);
    expect(r.searchedScope.capturePolicyVersion).toBe(AWARE);
    expect(r.searchedScope.rowsScanned).toBe(0); // tel/title are not interactive/navigational types
  });
});
