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

export interface BookingSignal {
  evidenceId: string;
  evidenceType: string;
  reason: 'keyword' | 'provider_host';
  matched: string;
}

export interface BookingDiscoveryResult {
  status: BookingDiscoveryStatus;
  signals: BookingSignal[];
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

function haystack(row: DeterministicEvidenceRow): string {
  return `${row.normalizedValue ?? ''} ${row.extractedValue ?? ''} ${row.sourceUrl ?? ''}`;
}

function signalFor(row: DeterministicEvidenceRow): BookingSignal | null {
  const hay = haystack(row);
  const provider = BOOKING_PROVIDER_HOST_RE.exec(hay);
  if (provider) return { evidenceId: row.id, evidenceType: row.evidenceType, reason: 'provider_host', matched: provider[0].toLowerCase() };
  const keyword = BOOKING_KEYWORD_RE.exec(hay);
  if (keyword) return { evidenceId: row.id, evidenceType: row.evidenceType, reason: 'keyword', matched: keyword[0].toLowerCase() };
  return null;
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
  for (const row of scannable) {
    const s = signalFor(row);
    if (s) signals.push(s);
  }
  const pageUrls = [...new Set(runEvidence.map((r) => r.sourceUrl).filter((u): u is string => u !== null))];

  const searchedScope = {
    capturePolicyVersion: capturePageSelectionPolicyVersion,
    bookingAware,
    evidenceTypesScanned: BOOKING_SCANNED_EVIDENCE_TYPES,
    pageUrls,
    rowsScanned: scannable.length,
  };

  // A positive booking signal always wins — it disproves booking-friction regardless of policy.
  if (signals.length > 0) {
    return { status: 'ONLINE_BOOKING_FOUND', signals, searchedScope, incompleteReason: null };
  }
  // Absence may be asserted ONLY over a booking-aware capture that actually captured pages.
  if (!bookingAware) {
    return { status: 'UNKNOWN', signals, searchedScope, incompleteReason: 'capture_not_booking_aware' };
  }
  if (pageUrls.length === 0) {
    return { status: 'UNKNOWN', signals, searchedScope, incompleteReason: 'no_captured_pages' };
  }
  return { status: 'NO_ONLINE_BOOKING', signals, searchedScope, incompleteReason: null };
}
