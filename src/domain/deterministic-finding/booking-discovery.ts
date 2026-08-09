import { PAGE_SELECTION_POLICY_VERSION } from '../capture/page-selection.js';
import { type DeterministicEvidenceRow } from './evidence-row.js';

/**
 * Bounded, deterministic online-booking discovery over ALREADY-CAPTURED evidence. No AI, no fuzzy
 * matching, no network, no crawl. It scans the interactive/navigational evidence a capture already
 * recorded (CTAs, links, nav labels, forms) for either a booking keyword or a recognized booking
 * provider host, and reports a searched scope so any downstream absence claim stays auditable.
 *
 * Critical absence rule: absence of online booking (NO_ONLINE_BOOKING) is asserted ONLY when the
 * reviewed capture was produced under a BOOKING-AWARE page-selection policy (i.e. one that actually
 * looks for a booking page — see `page-selection.ts`). A capture from an older policy that never
 * searched for a booking route yields UNKNOWN, never ABSENT. A positive signal is honored regardless
 * of policy version (finding booking always disproves booking-friction).
 */

export const BOOKING_DISCOVERY_VERSION = 'book-disc-1';

/** Page-selection policy versions that DO perform bounded booking-page discovery. */
export const BOOKING_AWARE_PAGE_SELECTION_VERSIONS: ReadonlySet<string> = new Set([
  PAGE_SELECTION_POLICY_VERSION, // current booking-aware version (cap-pages-2)
]);

/** Interactive/navigational evidence types a booking route can surface in. */
export const BOOKING_SCANNED_EVIDENCE_TYPES: readonly string[] = ['cta', 'link', 'nav_label', 'form'];
const SCANNED = new Set(BOOKING_SCANNED_EVIDENCE_TYPES);

/**
 * Booking keywords (English set required by the operator: book/booking/appointment/consultation/
 * reserve) plus the multilingual/scheduling terms already recognized elsewhere. Exact tokens only,
 * word-boundary anchored so a keyword is never matched inside an unrelated word — e.g. `book` must
 * not fire on "faceBOOK", which would otherwise mask a genuine booking-friction absence on any site
 * that merely links to Facebook.
 */
const BOOKING_KEYWORD_RE =
  /\b(book(?:ing)?|appointment|consultation|reserv(?:e|ation)|termin|buchen|rendez-?vous|online[- ]?scheduling|schedule (?:an? )?(?:appointment|visit)|jetzt buchen|book online)\b/i;

/** Recognized third-party booking provider hosts (exact, boundary-anchored — never fuzzy). */
const BOOKING_PROVIDER_HOST_RE = /\b(hsone|carestack|dentalhub|dentally|zesty)\b/i;

export type BookingDiscoveryStatus = 'ONLINE_BOOKING_FOUND' | 'NO_ONLINE_BOOKING' | 'UNKNOWN';

/**
 * A DIRECT signal (provider_host / booking_route / keyword) proves an online-booking route and drives
 * ONLINE_BOOKING_FOUND. A booking_intent signal is a booking-labelled control (e.g. "Book appointment")
 * whose destination is a NON-booking page (e.g. /contact): it records intent for auditability but is
 * NOT proof of online booking, so it never asserts presence.
 */
export interface BookingSignal {
  evidenceId: string;
  evidenceType: string;
  reason: 'keyword' | 'provider_host' | 'booking_route' | 'booking_intent';
  matched: string;
}

export interface BookingDiscoveryResult {
  status: BookingDiscoveryStatus;
  /** Direct online-booking signals (provider_host / booking_route / keyword). Drives the status. */
  signals: BookingSignal[];
  /** Booking-labelled controls whose destination is a non-booking page. Never proves booking. */
  intentSignals: BookingSignal[];
  searchedScope: {
    capturePolicyVersion: string | null;
    bookingAware: boolean;
    evidenceTypesScanned: readonly string[];
    pageUrls: string[];
    rowsScanned: number;
  };
  /** Set only when status is UNKNOWN — why absence could not be asserted. */
  incompleteReason: 'capture_not_booking_aware' | 'no_captured_pages' | null;
}

/**
 * Split a captured evidence row into what a control SAYS (visible text) and where it GOES
 * (destination: href / form action / link host). CTA evidence is encoded `text=<t> href=<d> tag=<x>`
 * by the capture extractor; older/other rows degrade safely (text only, no destination).
 */
function parts(row: DeterministicEvidenceRow): { text: string; dest: string } {
  const ev = row.extractedValue ?? '';
  const nv = row.normalizedValue ?? '';
  switch (row.evidenceType) {
    case 'cta': {
      const m = /^text=([\s\S]*?) href=([\s\S]*?)(?: tag=[a-z-]+)?$/i.exec(ev);
      if (m) return { text: m[1] ?? '', dest: m[2] ?? '' };
      return { text: ev, dest: '' }; // legacy CTA: visible text only, no destination captured
    }
    case 'link':
      return { text: '', dest: `${ev} ${nv}` }; // bare href + host; anchor text lives in a paired cta
    case 'form': {
      const m = /action=(\S*)/i.exec(ev);
      return { text: ev, dest: m ? (m[1] ?? '') : '' };
    }
    default:
      return { text: ev, dest: '' }; // nav_label et al.: text only
  }
}

/**
 * Classify one row. A recognized provider host or a booking keyword in the DESTINATION is a direct
 * booking route. A booking keyword only in the visible TEXT is a direct signal ONLY when no
 * destination was captured to contradict it; when the destination is a captured non-booking page it
 * is downgraded to booking_intent. A CTA is never treated as online booking merely because its text
 * says "book".
 */
function classify(row: DeterministicEvidenceRow): { direct?: BookingSignal; intent?: BookingSignal } {
  const { text, dest } = parts(row);
  const base = { evidenceId: row.id, evidenceType: row.evidenceType };
  const d = dest.trim();

  const provider = d ? BOOKING_PROVIDER_HOST_RE.exec(d) : null;
  if (provider) return { direct: { ...base, reason: 'provider_host', matched: provider[0].toLowerCase() } };

  const route = d ? BOOKING_KEYWORD_RE.exec(d) : null;
  if (route) return { direct: { ...base, reason: 'booking_route', matched: route[0].toLowerCase() } };

  const textKw = text ? BOOKING_KEYWORD_RE.exec(text) : null;
  if (textKw) {
    // Destination present but non-booking (provider/route checks failed) → intent, not proof.
    if (d) return { intent: { ...base, reason: 'booking_intent', matched: textKw[0].toLowerCase() } };
    // No destination captured to contradict the label → treat as a direct signal (fail-safe).
    return { direct: { ...base, reason: 'keyword', matched: textKw[0].toLowerCase() } };
  }
  return {};
}

/**
 * Run bounded booking discovery over one capture run's evidence.
 *
 * @param runEvidence ALL evidence rows for the reviewed capture run.
 * @param capturePageSelectionPolicyVersion the reviewed capture's page-selection policy version
 *   (null when unknown → treated as not booking-aware, fail-closed).
 */
export function discoverBooking(
  runEvidence: DeterministicEvidenceRow[],
  capturePageSelectionPolicyVersion: string | null,
): BookingDiscoveryResult {
  const bookingAware =
    capturePageSelectionPolicyVersion !== null &&
    BOOKING_AWARE_PAGE_SELECTION_VERSIONS.has(capturePageSelectionPolicyVersion);

  const scannable = runEvidence.filter((r) => SCANNED.has(r.evidenceType));
  const signals: BookingSignal[] = [];
  const intentSignals: BookingSignal[] = [];
  for (const row of scannable) {
    const { direct, intent } = classify(row);
    if (direct) signals.push(direct);
    if (intent) intentSignals.push(intent);
  }
  const pageUrls = [...new Set(runEvidence.map((r) => r.sourceUrl).filter((u): u is string => u !== null))];

  const searchedScope = {
    capturePolicyVersion: capturePageSelectionPolicyVersion,
    bookingAware,
    evidenceTypesScanned: BOOKING_SCANNED_EVIDENCE_TYPES,
    pageUrls,
    rowsScanned: scannable.length,
  };

  // A direct booking signal always wins — it disproves booking-friction regardless of policy.
  // Booking INTENT alone (a "book" control that routes to a non-booking page) never asserts presence.
  if (signals.length > 0) {
    return { status: 'ONLINE_BOOKING_FOUND', signals, intentSignals, searchedScope, incompleteReason: null };
  }
  // Absence may be asserted ONLY over a booking-aware capture that actually captured pages.
  if (!bookingAware) {
    return { status: 'UNKNOWN', signals, intentSignals, searchedScope, incompleteReason: 'capture_not_booking_aware' };
  }
  if (pageUrls.length === 0) {
    return { status: 'UNKNOWN', signals, intentSignals, searchedScope, incompleteReason: 'no_captured_pages' };
  }
  return { status: 'NO_ONLINE_BOOKING', signals, intentSignals, searchedScope, incompleteReason: null };
}
