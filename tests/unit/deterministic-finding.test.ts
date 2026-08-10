import { describe, expect, it } from 'vitest';
import {
  DETERMINISTIC_FINDING_PROVENANCE,
  DETERMINISTIC_FINDING_RULES_VERSION,
  DETERMINISTIC_FINDING_TEMPLATE_VERSION,
} from '../../src/domain/deterministic-finding/constants.js';
import {
  getDeterministicTemplate,
  isSupportedDeterministicCategory,
  SUPPORTED_DETERMINISTIC_CATEGORIES,
} from '../../src/domain/deterministic-finding/templates.js';
import { findProhibitedClaims } from '../../src/domain/deterministic-finding/prohibited.js';
import { computeDeterministicFindingHash } from '../../src/domain/deterministic-finding/hash.js';
import { validateDeterministicFinding } from '../../src/domain/deterministic-finding/validation.js';
import { resolveComposerFindings } from '../../src/domain/deterministic-finding/composer-projection.js';
import {
  type DeterministicEvidenceRow,
  type DeterministicFindingApprovalInput,
} from '../../src/domain/deterministic-finding/types.js';
import { type CaptureEvidenceType } from '../../src/domain/capture/capture-evidence.js';

const LEAD = 'lead-1';
const RUN = 'run-1';
const NOW = new Date('2026-08-08T12:00:00.000Z');

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

const TEL = ev('e-tel', 'tel', { extractedValue: '+44 20 1234 5678', normalizedValue: '+442012345678' });
const MAILTO = ev('e-mail', 'mailto', { extractedValue: 'reception@whitgift.example', normalizedValue: 'reception@whitgift.example' });
const TITLE = ev('e-title', 'title', { extractedValue: 'Whitgift Dental', normalizedValue: 'whitgift dental' });
// A booking-INTENT control: a "Book appointment" CTA whose destination is a non-booking (contact)
// page. This is the positive anchor for BOOKING_FRICTION support under det-find-2.
const BOOK_CTA = ev('e-book-cta', 'cta', {
  extractedValue: 'text=Book appointment href=https://whitgift.example/contact/ tag=a',
  normalizedValue: 'book appointment',
});

function baseInput(over: Partial<DeterministicFindingApprovalInput> = {}): DeterministicFindingApprovalInput {
  return {
    leadId: LEAD,
    category: 'BOOKING_FRICTION',
    operator: 'operator@example.com',
    now: NOW,
    findingId: 'find-1',
    requestedEvidenceIds: [BOOK_CTA.id],
    captureRun: { id: RUN, completedAt: new Date(NOW.getTime() - 2 * 86_400_000), pageSelectionPolicyVersion: 'cap-pages-2' },
    citedEvidence: [BOOK_CTA],
    runEvidence: [BOOK_CTA, TITLE],
    activeCategories: [],
    ...over,
  };
}

describe('deterministic finding — templates', () => {
  it('enables only BOOKING_FRICTION', () => {
    expect(SUPPORTED_DETERMINISTIC_CATEGORIES).toEqual(['BOOKING_FRICTION']);
    expect(isSupportedDeterministicCategory('BOOKING_FRICTION')).toBe(true);
    expect(isSupportedDeterministicCategory('SOCIAL_PROOF')).toBe(false);
  });

  it('scopes the observation to captured pages and never asserts a site-wide absence', () => {
    const t = getDeterministicTemplate('BOOKING_FRICTION');
    expect(t).not.toBeNull();
    expect(t?.observation).toMatch(/^On the pages reviewed,/);
    // Must NOT be an unrestricted "no online booking" / "no booking" site-wide claim.
    expect(t?.observation.toLowerCase()).not.toMatch(/\bno (online )?booking\b/);
    expect(t?.observation.toLowerCase()).not.toContain('contact form');
    expect(t?.recommendation).toContain('direct online appointment-booking path');
  });

  it('template wording passes its own prohibited-claim denylist', () => {
    const t = getDeterministicTemplate('BOOKING_FRICTION');
    expect(findProhibitedClaims(`${t?.observation ?? ''} ${t?.recommendation ?? ''}`)).toEqual([]);
  });
});

describe('deterministic finding — prohibited denylist', () => {
  it('flags each operator-prohibited claim', () => {
    expect(findProhibitedClaims('patients cannot book')).toContain('cannot_book');
    expect(findProhibitedClaims('the booking is broken')).toContain('booking_broken');
    expect(findProhibitedClaims('you are losing patients')).toContain('loss_claim');
    expect(findProhibitedClaims('this hurts your conversion')).toContain('conversion_claim');
    expect(findProhibitedClaims('lost revenue every month')).toContain('revenue_claim');
    expect(findProhibitedClaims('a competitor does this better')).toContain('competitor_claim');
    expect(findProhibitedClaims('there is no contact form')).toContain('contact_form_absence');
    expect(findProhibitedClaims('the page load time is slow')).toContain('performance_claim');
    expect(findProhibitedClaims('the banner video is blocked')).toContain('media_artifact_claim');
    expect(findProhibitedClaims('this will boost bookings by 30%')).toEqual(
      expect.arrayContaining(['numeric_percentage', 'performance_promise']),
    );
  });
});

describe('deterministic finding — hash', () => {
  it('is deterministic and independent of evidence-id ordering', () => {
    const a = computeDeterministicFindingHash({ leadId: LEAD, category: 'BOOKING_FRICTION', captureRunId: RUN, evidenceIds: ['b', 'a'], templateVersion: 'v', rulesVersion: 'r' });
    const b = computeDeterministicFindingHash({ leadId: LEAD, category: 'BOOKING_FRICTION', captureRunId: RUN, evidenceIds: ['a', 'b'], templateVersion: 'v', rulesVersion: 'r' });
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it('changes when an identity input changes', () => {
    const base = computeDeterministicFindingHash({ leadId: LEAD, category: 'BOOKING_FRICTION', captureRunId: RUN, evidenceIds: ['a'], templateVersion: 'v', rulesVersion: 'r' });
    const diff = computeDeterministicFindingHash({ leadId: 'other', category: 'BOOKING_FRICTION', captureRunId: RUN, evidenceIds: ['a'], templateVersion: 'v', rulesVersion: 'r' });
    expect(base).not.toBe(diff);
  });
});

describe('deterministic finding — validation', () => {
  it('accepts a valid BOOKING_FRICTION approval', () => {
    const r = validateDeterministicFinding(baseInput());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.finding.category).toBe('BOOKING_FRICTION');
    expect(r.finding.findingRef).toBe('D1');
    expect(r.finding.safeForOutreach).toBe(true);
    expect(r.finding.provenance).toBe(DETERMINISTIC_FINDING_PROVENANCE);
    expect(r.finding.templateVersion).toBe(DETERMINISTIC_FINDING_TEMPLATE_VERSION);
    expect(r.finding.rulesVersion).toBe(DETERMINISTIC_FINDING_RULES_VERSION);
    expect(r.finding.evidenceIds).toEqual([BOOK_CTA.id]);
    expect(r.finding.evidenceHash).toHaveLength(64);
    expect(r.finding.observation).toMatch(/^On the pages reviewed,/);
  });

  it('fails closed when cited evidence belongs to another lead', () => {
    const foreign = ev('e-foreign', 'tel', { leadId: 'other-lead' });
    const r = validateDeterministicFinding(baseInput({ requestedEvidenceIds: ['e-foreign'], citedEvidence: [foreign], runEvidence: [foreign] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violations).toContain('evidence_foreign:e-foreign');
  });

  it('fails closed when a cited evidence id does not exist', () => {
    const r = validateDeterministicFinding(baseInput({ requestedEvidenceIds: ['e-missing'], citedEvidence: [] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violations).toContain('evidence_missing:e-missing');
  });

  it('fails closed when cited evidence is from a different capture run', () => {
    const other = ev('e-other-run', 'tel', { captureRunId: 'run-2' });
    const r = validateDeterministicFinding(baseInput({ requestedEvidenceIds: ['e-other-run'], citedEvidence: [other], runEvidence: [other] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violations).toContain('evidence_wrong_run:e-other-run');
  });

  it('fails closed when the capture is stale', () => {
    const r = validateDeterministicFinding(baseInput({ captureRun: { id: RUN, completedAt: new Date(NOW.getTime() - 40 * 86_400_000), pageSelectionPolicyVersion: 'cap-pages-2' } }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violations).toContain('capture_stale');
  });

  it('fails closed (UNKNOWN, not ABSENT) when the capture is not booking-aware', () => {
    // An older capture that never searched for a booking page cannot support a booking-absence claim.
    const r = validateDeterministicFinding(baseInput({ captureRun: { id: RUN, completedAt: new Date(NOW.getTime() - 2 * 86_400_000), pageSelectionPolicyVersion: 'cap-pages-1' } }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violations).toContain('booking_discovery_incomplete');
    expect(r.violations).not.toContain('direct_booking_signal_present');
  });

  it('fails closed when a recognized booking provider link exists in the reviewed capture', () => {
    const hsone = ev('e-hsone', 'link', {
      extractedValue: 'https://booking.uk.hsone.app/soe/new/Whitgift%20Dental?pid=UKLAL01',
      normalizedValue: 'booking.uk.hsone.app',
    });
    const r = validateDeterministicFinding(baseInput({ runEvidence: [TEL, MAILTO, hsone] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violations).toContain('direct_booking_signal_present');
  });

  it('fails closed for an unsupported category', () => {
    const r = validateDeterministicFinding(baseInput({ category: 'SOCIAL_PROOF' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violations).toContain('category_unsupported');
  });

  it('fails closed when the reviewed capture has no booking-intent control', () => {
    // Only a phone row + title, no "book"-labelled control → nothing positively shows booking friction.
    const r = validateDeterministicFinding(baseInput({ requestedEvidenceIds: [TEL.id], citedEvidence: [TEL], runEvidence: [TEL, TITLE] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violations).toContain('booking_intent_absent');
  });

  it('fails closed when the operator cites no booking-intent control from the capture', () => {
    // A booking-intent CTA exists in the run, but the operator cited only the (non-intent) title row.
    const r = validateDeterministicFinding(baseInput({ requestedEvidenceIds: [TITLE.id], citedEvidence: [TITLE], runEvidence: [BOOK_CTA, TITLE] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violations).toContain('cited_evidence_not_booking_intent');
    expect(r.violations).not.toContain('booking_intent_absent');
  });

  it('fails closed when a direct online-booking signal exists in the reviewed capture', () => {
    const bookCta = ev('e-book', 'cta', { extractedValue: 'Book online', normalizedValue: 'book online' });
    const r = validateDeterministicFinding(baseInput({ runEvidence: [TEL, MAILTO, bookCta] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violations).toContain('direct_booking_signal_present');
  });

  it('fails closed when an active finding for the same category already exists', () => {
    const r = validateDeterministicFinding(baseInput({ activeCategories: ['BOOKING_FRICTION'] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violations).toContain('duplicate_active_finding');
  });

  it('fails closed with no evidence and no capture run', () => {
    const empty = validateDeterministicFinding(baseInput({ requestedEvidenceIds: [], citedEvidence: [] }));
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.violations).toContain('no_evidence');

    const noRun = validateDeterministicFinding(baseInput({ captureRun: null }));
    expect(noRun.ok).toBe(false);
    if (noRun.ok) return;
    expect(noRun.violations).toContain('no_capture_run');
  });
});

describe('deterministic finding — composer projection', () => {
  const detFinding = {
    id: 'det-1',
    findingRef: 'D1',
    category: 'BOOKING_FRICTION' as const,
    safeForOutreach: true,
    observation: 'obs',
    recommendation: 'rec',
  };
  const aiSafe = {
    auditRunId: 'audit-1',
    opportunityScore: 72,
    findings: [{ id: 'ai-1', findingRef: 'F1', category: 'BOOKING_FRICTION' as const, safeForOutreach: true, observation: 'o', recommendation: 'r' }],
  };
  const aiUnsafe = {
    auditRunId: 'audit-1',
    opportunityScore: null,
    findings: [{ id: 'ai-1', findingRef: 'F1', category: 'BOOKING_FRICTION' as const, safeForOutreach: false, observation: 'o', recommendation: 'r' }],
  };

  it('uses the AI audit when it has an outreach-safe finding', () => {
    const r = resolveComposerFindings(aiSafe, [detFinding]);
    expect(r.source).toBe('AI');
    expect(r.auditRunId).toBe('audit-1');
    expect(r.findings[0]?.id).toBe('ai-1');
  });

  it('falls back to the deterministic finding when the AI audit has no safe finding', () => {
    const r = resolveComposerFindings(aiUnsafe, [detFinding]);
    expect(r.source).toBe('DETERMINISTIC_OPERATOR_APPROVED');
    expect(r.auditRunId).toBeNull();
    expect(r.findings[0]?.id).toBe('det-1');
  });

  it('falls back to the deterministic finding when there is no AI audit at all', () => {
    const r = resolveComposerFindings(null, [detFinding]);
    expect(r.source).toBe('DETERMINISTIC_OPERATOR_APPROVED');
    expect(r.findings).toHaveLength(1);
  });

  it('reports no source when neither is available', () => {
    const r = resolveComposerFindings(null, []);
    expect(r.source).toBeNull();
    expect(r.findings).toHaveLength(0);
  });

  it('never lets a deterministic finding override a real AI audit', () => {
    const r = resolveComposerFindings(aiSafe, [detFinding]);
    expect(r.source).toBe('AI');
  });
});
