/**
 * Phase 9 — cold email writer types. One factual, human-reviewable email per lead: one
 * subject, a neutral greeting, 1–3 short paragraphs (~120 words max), one CTA, a simple
 * signoff. The model authors ONLY the subject + body prose + structured selections; the
 * greeting, CTA sentence, signoff, and any demo link are assembled deterministically. No
 * sending, no Gmail drafts, no deployment (see [[project-outreach-system]]).
 */

export const EMAIL_WRITER_RULES_VERSION = 'email-writer-1';

/** The ONLY demo-link token the writer may reference. The real URL is substituted in
 * Phase 11 after a verified Netlify deployment — never by the model, never in Phase 9. */
export const DEMO_URL_TOKEN = '{{DEMO_URL}}';

/** CTA kind. `demo_link` is allowed ONLY when a human-APPROVED, deployment-eligible demo
 * exists; otherwise the writer must use `reply`. */
export const CTA_KINDS = ['reply', 'demo_link'] as const;
export type EmailCtaKind = (typeof CTA_KINDS)[number];

/** Vetted CTA label keys → fixed sentence (resolved in email-render). No free-form CTA. */
export const CTA_LABEL_KEYS = ['REPLY_TO_LEARN_MORE', 'HAPPY_TO_SHARE_DETAILS', 'SEE_THE_CONCEPT', 'TAKE_A_QUICK_LOOK'] as const;
export type EmailCtaLabelKey = (typeof CTA_LABEL_KEYS)[number];

/** Which label keys are valid for each CTA kind. */
export const CTA_LABELS_FOR_KIND: Record<EmailCtaKind, EmailCtaLabelKey[]> = {
  reply: ['REPLY_TO_LEARN_MORE', 'HAPPY_TO_SHARE_DETAILS'],
  demo_link: ['SEE_THE_CONCEPT', 'TAKE_A_QUICK_LOOK'],
};

/** Vetted signoffs. */
export const SIGNOFF_KEYS = ['BEST_REGARDS', 'KIND_REGARDS', 'THANKS'] as const;
export type SignoffKey = (typeof SIGNOFF_KEYS)[number];

/** Greeting style the model requests; NAMED is honoured only when a verified contact-name
 * fact exists (else the renderer falls back to the neutral greeting). */
export const GREETING_STYLES = ['NEUTRAL', 'NAMED'] as const;
export type GreetingStyle = (typeof GREETING_STYLES)[number];

/** Fact fields the email may reference (must resolve to a verified fact). */
export const EMAIL_FACT_KEYS = ['business_name', 'city', 'services', 'contact_name'] as const;
export type EmailFactKey = (typeof EMAIL_FACT_KEYS)[number];

/** Persisted email lifecycle. Generation is separate from human approval + sending. */
export const EMAIL_STATUSES = ['DRAFTED', 'APPROVED', 'REVIEW_FAILED'] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

export const MAX_EMAIL_WORDS = 120;
export const MAX_BODY_PARAGRAPHS = 3;

/** Structured writer output (strict JSON). The model writes subject + body prose and makes
 * bounded structured selections; it never writes greeting/CTA/signoff text or any URL. */
export interface EmailWriterOutput {
  subject: string;
  bodyParagraphs: string[]; // 1..3
  greetingStyle: GreetingStyle;
  ctaKind: EmailCtaKind;
  ctaLabelKey: EmailCtaLabelKey;
  signoffKey: SignoffKey;
  factRefs: EmailFactKey[];
  findingRefs: string[];
}

export const REVIEW_DECISIONS = ['APPROVE', 'REVISE', 'REJECT'] as const;
export type EmailReviewDecision = (typeof REVIEW_DECISIONS)[number];

/** Independent adversarial reviewer verdict. */
export interface EmailReviewOutput {
  decision: EmailReviewDecision;
  /** Any claim/number/name/result not supported by verified facts/findings/demo. */
  fabricationRisk: boolean;
  /** Every personalized statement traces to a verified fact or accepted finding. */
  personalizationSupported: boolean;
  /** No revenue/traffic/ranking/conversion/performance claim. */
  claimHonest: boolean;
  /** On REVISE: does a requested revision need a new fact / new claim / a CTA change? */
  revisionRequiresNewFacts: boolean;
  revisionRequiresNewClaims: boolean;
  revisionRequiresCtaChange: boolean;
  problems: string[];
}

/** A rendered, provenance-tracked email ready for human review (never sent in Phase 9). */
export interface RenderedEmail {
  subject: string;
  /** Full plain-text body incl. greeting, paragraphs, CTA sentence, signoff. May contain
   * the {{DEMO_URL}} token (unresolved until Phase 11). */
  body: string;
  ctaKind: EmailCtaKind;
  /** True when the body contains an unresolved {{DEMO_URL}} token → not send-ready. */
  hasDemoUrlPlaceholder: boolean;
  factInputs: { factId: string; factType: string; field: string }[];
  findingInputs: { findingId: string; findingRef: string; directive: string }[];
}
