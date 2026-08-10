/**
 * Deterministic-finding prohibited-wording denylist (defense in depth).
 *
 * Observation/recommendation text is already template-controlled, so prohibited wording cannot
 * normally appear. This denylist is a hard gate applied to the rendered text anyway, so that any
 * future template edit that drifts into a forbidden claim is caught deterministically before a
 * finding can be marked safe-for-outreach. It encodes the exact prohibitions the operator approved:
 *
 *   - "patients cannot book" / "booking is broken"     (overstated capability/defect)
 *   - "losing patients"                                 (harm/loss framing)
 *   - conversion / revenue / sales impact               (commercial-impact claims)
 *   - competitor performance                            (competitor claims)
 *   - contact-form absence                              (un-captured-page inference)
 *   - performance / load-time                           (performance inference)
 *   - media / banner / video artifact                   (capture-artifact-as-defect)
 */
export const DETERMINISTIC_PROHIBITED_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Overstated capability / defect.
  [/\b(can(?:no|')t|cannot|unable to)\s+book\b/i, 'cannot_book'],
  [/\bbooking\b[^.]*\bbroken\b/i, 'booking_broken'],
  [/\b(broken|not working|doesn'?t work)\b/i, 'broken_claim'],
  // Harm / loss framing.
  [/\blos(?:e|ing|t)\s+(patients?|customers?|clients?|leads?|business|revenue|sales)\b/i, 'loss_claim'],
  [/\bmissed?\s+(appointments?|bookings?|revenue|business)\b/i, 'missed_business_claim'],
  // Commercial-impact claims.
  [/\bconversion(s| rate)?\b/i, 'conversion_claim'],
  [/\b(revenue|sales|profit|turnover)\b/i, 'revenue_claim'],
  [/\b\d+(\.\d+)?\s?%/, 'numeric_percentage'],
  // Competitor performance.
  [/\b(competitor|competing|rival|other (?:practices|clinics|businesses))\b/i, 'competitor_claim'],
  // Un-captured-page inference (contact form absence) — never claim from bounded capture.
  [/\b(no|missing|lacks?|without (?:a|an)?)\s+contact form\b/i, 'contact_form_absence'],
  // Performance / load-time inference.
  [/\b(load[- ]?time|page speed|slow(?:ly)?|performance|latency)\b/i, 'performance_claim'],
  // Capture-artifact-as-defect (blocked banner/video artifact).
  [/\b(banner|video|carousel|slider|pop-?up)\b/i, 'media_artifact_claim'],
  // Generic performance promises / guarantees.
  [/\b(guarantee[sd]?|will (?:definitely|surely)|boost|double|increase)\b/i, 'performance_promise'],
];

/** Returns the list of prohibited-claim labels present in `text` (empty when clean). */
export function findProhibitedClaims(text: string): string[] {
  const hits: string[] = [];
  for (const [re, label] of DETERMINISTIC_PROHIBITED_PATTERNS) {
    if (re.test(text)) hits.push(label);
  }
  return hits;
}
