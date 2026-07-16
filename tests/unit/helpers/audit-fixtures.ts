import { type AcceptedFinding, type AuditCategory, type Severity } from '../../../src/domain/audit/audit-types.js';
import {
  buildEvidencePackage,
  type EvidencePackage,
  type EvidenceRef,
} from '../../../src/domain/audit/evidence-package.js';

export const PRIMARY_URL = 'https://www.testdental.example/';

let n = 0;
export function evidenceRef(overrides: Partial<EvidenceRef> = {}): EvidenceRef {
  n += 1;
  return {
    id: `ev-${n}`,
    leadId: 'lead-1',
    captureRunId: 'cap-1',
    capturedPageId: 'page-1',
    profile: 'desktop',
    evidenceType: 'cta',
    sourceUrl: PRIMARY_URL,
    extractedValue: 'Book an appointment',
    normalizedValue: 'book an appointment',
    ...overrides,
  };
}

export function evidenceImage(overrides: Partial<import('../../../src/domain/audit/evidence-package.js').EvidenceImage> = {}): import('../../../src/domain/audit/evidence-package.js').EvidenceImage {
  return {
    id: 'art-1',
    sha256: 'deadbeef',
    profile: 'desktop',
    mediaType: 'image/png',
    dataBase64: '',
    role: 'primary',
    widthPx: 768,
    heightPx: 480,
    ...overrides,
  };
}

export function testPackage(evidence: EvidenceRef[] = [evidenceRef(), evidenceRef({ evidenceType: 'tel', extractedValue: '+43 1 111' })]): EvidencePackage {
  return buildEvidencePackage({
    leadId: 'lead-1',
    captureRunId: 'cap-1',
    facts: { businessName: 'Test Dental', category: 'dental_clinic', city: 'Vienna', officialDomain: 'www.testdental.example' },
    primaryUrl: PRIMARY_URL,
    evidence,
    images: [],
    versions: { extractor: 't', emulation: 't', pageSelection: 't' },
    limits: { maxEvidence: 50, maxSecondaryPages: 3, maxEvidenceChars: 300, maxImages: 2 },
  });
}

export function acceptedFinding(overrides: Partial<AcceptedFinding> = {}): AcceptedFinding {
  n += 1;
  return {
    id: `id-${n}`,
    findingRef: `F${n}`,
    category: 'CTA_CLARITY' as AuditCategory,
    observation: 'The main action may be hard to notice.',
    evidenceIds: ['ev-1'],
    affectedUrls: [PRIMARY_URL],
    affectedProfiles: ['DESKTOP'],
    severity: 'MEDIUM' as Severity,
    confidence: 0.8,
    businessImpact: 'May create friction for visitors ready to book.',
    recommendation: 'Make the primary action more prominent.',
    safeForOutreach: true,
    outreachAngle: null,
    uncertainty: null,
    reviewDecision: 'APPROVE',
    ...overrides,
  };
}
