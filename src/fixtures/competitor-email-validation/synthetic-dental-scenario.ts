/**
 * Phase 7A4A — SYNTHETIC, FICTIONAL dental-clinic validation scenario. Everything here is invented for
 * offline validation: no real company, domain, person, address, phone, review, or asset. All identifiers
 * use the RFC-reserved `.example` TLD and clearly synthetic names/ids.
 *
 * The scenario feeds the REAL Phase 7A1–7A3B services (see the harness). It provides:
 *   - a prospect profile + verified prospect audit finding (mobile booking discoverability),
 *   - an explicit, scoped SYNTHETIC prospect NEGATIVE observation (Decision G1) proving the prospect
 *     lacks a booking CTA in the mobile initial viewport — entered ONLY through the prospect-evidence
 *     input boundary, never injected into the package/contrast/composer/final email,
 *   - three fictional comparable clinics whose homepages each expose an online booking control (a valid
 *     three-of-three booking pattern; the anonymized outreach wording is produced by the real 7A3A logic,
 *     never authored here),
 *   - lead facts + safe findings for email composition,
 *   - one pinned, deterministic prospect-only base email draft used IDENTICALLY for the baseline and the
 *     enriched path (the only difference between the two emails is the approved competitor enrichment).
 */

import { type CompetitorInputCandidate, type ProspectProfileInput } from '../../domain/competitor/types.js';
import { type ProspectEvidenceInput } from '../../domain/competitor/pattern-types.js';
import { type MockPageSpec } from '../../integrations/capture/mock-capture.js';
import { type EmailFinding } from '../../domain/email/email-render.js';
import { type LeadFact } from '../../domain/lead-facts/lead-fact.js';
import { type EmailWriterParsed } from '../../domain/email/email-schema.js';

/** Fixed clock so every run of the harness is byte-identical (never the wall clock). */
export const FIXTURE_NOW = new Date('2026-08-01T12:00:00.000Z');
/** Prospect capture is recent (fresh well within the 30-day window) relative to FIXTURE_NOW. */
export const PROSPECT_CAPTURED_AT = new Date('2026-07-30T09:00:00.000Z');

export const SCENARIO_LABEL = 'SYNTHETIC-DENTAL-BOOKING-DISCOVERABILITY';
export const SYNTHETIC_LEAD_ID = 'synthetic-lead-northgate-dental';
export const PROSPECT_NORMALIZED_DOMAIN = 'northgate-dental.example';

/** The prospect's comparability profile (fictional London general-dentistry practice). */
export const prospectProfile: ProspectProfileInput = {
  leadId: SYNTHETIC_LEAD_ID,
  website: `https://${PROSPECT_NORMALIZED_DOMAIN}`,
  primaryCategory: 'dentist',
  secondaryCategories: ['general dentistry'],
  latitude: 51.5007,
  longitude: -0.1246,
  city: 'London',
  market: 'gb',
  language: 'en',
  businessType: 'independent',
  parentBrand: null,
};

/** Three fictional comparable clinics, all valid, within radius, same category/market/language. */
export const competitorCandidates: CompetitorInputCandidate[] = [
  {
    rowIndex: 0, providerCandidateId: 'syn-cand-aldergrove', businessName: 'Aldergrove',
    website: 'https://aldergrove.example', primaryCategory: 'dentist', secondaryCategories: ['general dentistry'],
    latitude: 51.5051, longitude: -0.1180, address: '1 Synthetic Row, London', city: 'London',
    market: 'gb', language: 'en', businessType: 'independent', parentBrand: null, branchId: null,
  },
  {
    rowIndex: 1, providerCandidateId: 'syn-cand-brackenfield', businessName: 'Brackenfield',
    website: 'https://brackenfield.example', primaryCategory: 'dentist', secondaryCategories: ['general dentistry'],
    latitude: 51.4980, longitude: -0.1250, address: '2 Synthetic Row, London', city: 'London',
    market: 'gb', language: 'en', businessType: 'independent', parentBrand: null, branchId: null,
  },
  {
    rowIndex: 2, providerCandidateId: 'syn-cand-cindermoor', businessName: 'Cindermoor',
    website: 'https://cindermoor.example', primaryCategory: 'dentist', secondaryCategories: ['general dentistry'],
    latitude: 51.5100, longitude: -0.1100, address: '3 Synthetic Row, London', city: 'London',
    market: 'gb', language: 'en', businessType: 'independent', parentBrand: null, branchId: null,
  },
];

/** Minimal synthetic homepage HTML: a single visible booking anchor → deterministic BOOKING_CTA_VISIBLE. */
function bookingHomepage(origin: string, name: string): string {
  return `<!doctype html><html lang="en"><head><title>${name}</title></head><body>` +
    `<h1>${name}</h1>` +
    `<a href="${origin}/book">Book an appointment</a>` +
    `</body></html>`;
}

/** Page map for MockCaptureProvider (keyed by the exact origin URL eligibility derives: https://<domain>). */
export function competitorPages(): Map<string, MockPageSpec> {
  const pages = new Map<string, MockPageSpec>();
  for (const c of competitorCandidates) {
    const origin = c.website!;
    pages.set(origin, { html: bookingHomepage(origin, c.businessName!), ok: true, finalUrl: origin });
  }
  return pages;
}

/**
 * Rich SYNTHETIC prospect negative record (Decision G1). This is the fixture-layer artifact; the harness
 * maps it onto the production `ProspectEvidenceInput.negatives` boundary. It is EXPLICIT and SCOPED —
 * absence is never inferred from a missing row, empty detector, uncaptured page, or bounded capture.
 */
export interface SyntheticProspectNegative {
  synthetic: true;
  category: 'BOOKING_CTA_VISIBLE';
  polarity: 'ABSENT';
  inspectionScope: string;
  viewport: 'mobile-initial-viewport';
  sourceCaptureId: string;
  capturedAt: Date;
  confidence: 'HIGH';
  ruleVersion: string;
  locator: { check: string; selectorScope: string; result: 'no-booking-control-in-initial-viewport' };
}

export const syntheticProspectNegative: SyntheticProspectNegative = {
  synthetic: true,
  category: 'BOOKING_CTA_VISIBLE',
  polarity: 'ABSENT',
  inspectionScope: 'mobile-initial-viewport',
  viewport: 'mobile-initial-viewport',
  sourceCaptureId: 'synthetic-prospect-capture-1',
  capturedAt: PROSPECT_CAPTURED_AT,
  confidence: 'HIGH',
  ruleVersion: 'synthetic-prospect-negative-2026-08-01',
  locator: {
    check: 'above-the-fold-booking-control-scan',
    selectorScope: 'initial-viewport(mobile 390x844)',
    result: 'no-booking-control-in-initial-viewport',
  },
};

/**
 * Map the synthetic negative onto the real prospect-evidence input contract. `refs` is intentionally
 * empty (no cta/form primitive observed → not PRESENT), and the explicit scoped negative is what permits
 * a VERIFIED prospect ABSENT contrast in pattern-logic. `now` re-derives freshness deterministically.
 */
export function prospectEvidenceInput(): ProspectEvidenceInput {
  return {
    leadId: SYNTHETIC_LEAD_ID,
    captureRunId: syntheticProspectNegative.sourceCaptureId,
    capturedAt: syntheticProspectNegative.capturedAt,
    capturedOk: true,
    refs: [],
    negatives: [
      {
        category: syntheticProspectNegative.category,
        inspectionScope: syntheticProspectNegative.inspectionScope,
        evidenceRef: syntheticProspectNegative.sourceCaptureId,
      },
    ],
  };
}

const FACT_BASE = {
  leadId: SYNTHETIC_LEAD_ID,
  normalizedValue: null,
  sourceType: 'mock' as const,
  sourceUrl: null,
  capturedAt: FIXTURE_NOW,
  confidence: 1,
  supersededBy: null,
  supersededAt: null,
  isCurrent: true,
};

/** Lead facts for email context (English-language; no German TLD/country → resolveEmailLanguage = en). */
export const leadFacts: LeadFact[] = [
  { ...FACT_BASE, id: 'fact-business-name', factType: 'business_name', value: 'Northgate Dental Studio' },
  { ...FACT_BASE, id: 'fact-city', factType: 'city', value: 'London' },
  { ...FACT_BASE, id: 'fact-country', factType: 'country', value: 'gb' },
  { ...FACT_BASE, id: 'fact-category', factType: 'category', value: 'dentist' },
];

/** The verified prospect audit finding: mobile booking discoverability (BOOKING_FRICTION), safe. */
export const BOOKING_FINDING_ID = 'fnd-booking-friction';
export const safeFindings: EmailFinding[] = [
  {
    id: BOOKING_FINDING_ID,
    findingRef: 'F1',
    category: 'BOOKING_FRICTION',
    safeForOutreach: true,
    observation: 'On a phone, there is no booking action in the first screen; the phone number sits in the footer.',
    recommendation: 'Surface a clear booking option near the top of the mobile page.',
  },
];

/**
 * Pinned deterministic prospect-only base email (competitor_evidence_used = NONE). Used IDENTICALLY as
 * the base draft for BOTH the baseline and the enriched composition, so the only material difference is
 * the approved competitor enrichment. Crafted to pass the real deterministic copy gate.
 */
export const baseEmailDraft: EmailWriterParsed = {
  subject_options: [
    'Booking on your dental website',
    'Making appointments easier to find on mobile',
    'The booking step on your phone site',
  ],
  selected_subject: 'Booking on your dental website',
  selected_subject_reason: 'Names the concrete booking issue without hype.',
  email_body:
    'On your website, the option to request an appointment from a phone is not shown in the first screen a new patient sees. The phone number sits further down in the footer.\n\n' +
    'A clear booking option near the top of the mobile page would let a first-time patient start an appointment without searching the whole site.',
  evidence_ids: [BOOKING_FINDING_ID, 'fact-business-name'],
  strategic_angle: 'Reduce friction in the first mobile screen.',
  business_relevance: 'How a new patient reaches you affects whether they act on the site.',
  urgency_basis: 'This is a standing usability point, not time sensitive.',
  competitor_evidence_used: 'NONE',
  primary_cta: 'REPLY_FOR_DETAILS',
  prohibited_phrase_scan: 'PASS',
  punctuation_scan: 'PASS',
  genericity_score: 18,
  human_style_result: 'PASS',
  demo_alignment_result: 'NOT_APPLICABLE',
};
