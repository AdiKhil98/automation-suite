/**
 * Phase 9 cold-email copy contract. The model supplies evidence-bound strategy and
 * prose. Greeting, CTA sentence, signoff, and URL insertion remain deterministic.
 */

export const EMAIL_WRITER_RULES_VERSION = 'email-copy-standard-3';
export const DEMO_URL_TOKEN = '{{DEMO_URL}}';

export const PRIMARY_CTAS = ['VIEW_CONCEPT', 'REPLY_FOR_DETAILS'] as const;
export type EmailPrimaryCta = (typeof PRIMARY_CTAS)[number];

export const CTA_KINDS = ['reply', 'demo_link'] as const;
export type EmailCtaKind = (typeof CTA_KINDS)[number];

export const EMAIL_STATUSES = ['DRAFTED', 'APPROVED', 'REVIEW_FAILED'] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

export const SCAN_RESULTS = ['PASS', 'FAIL'] as const;
export type EmailScanResult = (typeof SCAN_RESULTS)[number];

export const DEMO_ALIGNMENT_RESULTS = ['PASS', 'NOT_APPLICABLE', 'FAIL'] as const;
export type DemoAlignmentResult = (typeof DEMO_ALIGNMENT_RESULTS)[number];

/**
 * Phase 7A3B — competitor evidence mode on an email artifact. `NONE` is prospect-only (the raw model
 * output always emits NONE; the model never authors competitor text). `APPROVED_COMPETITOR_PATTERN_PACKAGE`
 * is set by the deterministic composer on the FINAL enriched artifact only.
 */
export const EMAIL_COMPETITOR_EVIDENCE_MODES = ['NONE', 'APPROVED_COMPETITOR_PATTERN_PACKAGE'] as const;
export type EmailCompetitorEvidenceMode = (typeof EMAIL_COMPETITOR_EVIDENCE_MODES)[number];

export const MAX_EMAIL_WORDS = 120;
export const MAX_SUBJECT_LENGTH = 80;

/** Exact structured writer output required by the Cold Email Copy Standard. */
export interface EmailWriterOutput {
  /** Exactly three; enforced by the runtime schema. */
  subject_options: string[];
  selected_subject: string;
  selected_subject_reason: string;
  email_body: string;
  evidence_ids: string[];
  strategic_angle: string;
  business_relevance: string;
  urgency_basis: string;
  competitor_evidence_used: EmailCompetitorEvidenceMode;
  primary_cta: EmailPrimaryCta;
  prohibited_phrase_scan: EmailScanResult;
  punctuation_scan: EmailScanResult;
  genericity_score: number;
  human_style_result: EmailScanResult;
  demo_alignment_result: DemoAlignmentResult;
}

export const REVIEW_DECISIONS = ['APPROVE', 'APPROVE_WITH_REVISIONS', 'REJECT'] as const;
export type EmailReviewDecision = (typeof REVIEW_DECISIONS)[number];

/** Independent reviewer verdict. Every quality dimension is fail-closed. */
export interface EmailReviewOutput {
  decision: EmailReviewDecision;
  fabricationRisk: boolean;
  subjectSpecific: boolean;
  subjectCuriosityGap: boolean;
  openingSpecific: boolean;
  businessRelevanceClear: boolean;
  urgencySupported: boolean;
  competitorClaimsSupported: boolean;
  humanStylePass: boolean;
  punctuationPass: boolean;
  singlePrimaryCta: boolean;
  sufficientlyPersonalized: boolean;
  evidenceSupported: boolean;
  demoAligned: boolean;
  persuasive: boolean;
  problems: string[];
  requiredRevisions: string[];
}

export interface RenderedEmail {
  subject: string;
  body: string;
  ctaKind: EmailCtaKind;
  hasDemoUrlPlaceholder: boolean;
  factInputs: { factId: string; factType: string; field: string }[];
  findingInputs: { findingId: string; findingRef: string; directive: string }[];
}
