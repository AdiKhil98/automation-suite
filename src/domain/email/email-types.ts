import { type SequenceStep } from '../outreach/sequence.js';

/**
 * Phase 9 cold-email copy contract. The model supplies evidence-bound strategy and
 * prose. Greeting, CTA sentence, signoff, and URL insertion remain deterministic.
 */

export const EMAIL_WRITER_RULES_VERSION = 'email-copy-standard-4';
export const DEMO_URL_TOKEN = '{{DEMO_URL}}';

/**
 * WHERE an email sits in the outreach sequence, stated explicitly rather than inferred from the
 * copy. Both the deterministic validator and the renderer key off this single value, so "is this a
 * threaded follow-up?" has exactly one answer per composition.
 *
 * Step 0 (Outreach #1) authors its own subject. Steps 1-3 continue an EXISTING Gmail thread, so
 * their subject is deterministic thread continuity produced by code (see `replySubject`) and the
 * model's subject fields are a contract echo, not copy.
 */
export interface EmailSequencePosition {
  step: SequenceStep;
  /** The exact subject of the thread a follow-up continues. Always null for step 0. */
  threadSubject: string | null;
  /**
   * The bodies already SENT in this thread, oldest first. Required, because the deterministic
   * anti-repetition gate compares a follow-up against them: a step >= 1 composed with an empty list
   * cannot be checked for repetition at all, so the omission has to be a deliberate `[]` rather than
   * a forgotten field.
   */
  priorMessageBodies: readonly string[];
}

/** A first email: the model authors the subject, and there is no thread to continue or repeat. */
export const INITIAL_EMAIL_SEQUENCE: EmailSequencePosition = {
  step: 0, threadSubject: null, priorMessageBodies: [],
};

/**
 * Deterministic reply subject: prefix once, never twice. This is the ONLY rule in the system for
 * what a threaded subject looks like — the renderer builds the outgoing subject with it, and the
 * validator compares the model's echo through it, so neither can drift from the other.
 */
export function replySubject(original: string): string {
  const trimmed = original.trim();
  return /^re:\s/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}


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
  /** Day-1 single-observation quality gate. All four are fail-closed and required for APPROVE. */
  singleObservation: boolean;
  buyerLanguageOnly: boolean;
  conversationNotAudit: boolean;
  confidentObservation: boolean;
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
