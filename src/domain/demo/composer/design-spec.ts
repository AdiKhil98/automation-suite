/**
 * Phase 8B — the structured contract the AI Demo Composer produces INSTEAD of raw markup.
 *
 * The model never emits HTML, CSS, or JavaScript. It only chooses from the closed
 * allow-lists below: which vetted components to place, in what order, with which verified
 * facts and which accepted finding each section addresses, plus a visual direction and CTA
 * intent. A deterministic renderer (see compose.ts) turns a VALIDATED spec into a page using
 * only the vetted component library (components.ts). Everything the model can say is an enum
 * member or a reference that must resolve to real evidence — there is no free-form markup
 * field anywhere in this contract.
 */

export const DESIGN_SPEC_VERSION = 'demo-design-spec-1';

/** Visual direction → a vetted theme (palette + type treatment). Closed set. */
export const VISUAL_DIRECTIONS = ['CLEAN_CLINICAL', 'WARM_WELCOMING', 'MODERN_BOLD'] as const;
export type VisualDirection = (typeof VISUAL_DIRECTIONS)[number];

/** How the hero leads. Influences hero copy emphasis only — never invents claims. */
export const HERO_STRATEGIES = ['CLARITY_FIRST', 'TRUST_FIRST', 'ACTION_FIRST', 'LOCAL_FIRST'] as const;
export type HeroStrategy = (typeof HERO_STRATEGIES)[number];

/** Per-section messaging emphasis. Selects vetted, generic section copy — no fabrication. */
export const MESSAGING_EMPHASES = ['CLARITY', 'TRUST', 'CONVENIENCE', 'LOCAL', 'PROFESSIONALISM'] as const;
export type MessagingEmphasis = (typeof MESSAGING_EMPHASES)[number];

/** Primary CTA intent. The actual href is resolved DETERMINISTICALLY from verified facts;
 * a 'booking' intent is only honoured when a verified booking URL exists (else downgraded). */
export const CTA_INTENTS = ['booking', 'contact', 'call', 'scroll'] as const;
export type CtaIntent = (typeof CTA_INTENTS)[number];

/** Vetted CTA label keys → fixed display text (resolved in compose.ts). No free text. */
export const CTA_LABEL_KEYS = ['BOOK_APPOINTMENT', 'REQUEST_APPOINTMENT', 'CONTACT_US', 'CALL_US', 'GET_IN_TOUCH'] as const;
export type CtaLabelKey = (typeof CTA_LABEL_KEYS)[number];

/** Fact fields a section may reference. Each maps to a DemoContent value that must exist. */
export const FACT_KEYS = ['business_name', 'city', 'phone', 'email', 'address', 'opening_hours', 'services', 'website', 'booking_url'] as const;
export type FactKey = (typeof FACT_KEYS)[number];

/** Header/footer variants (placed deterministically at top/bottom; the model picks a variant). */
export const HEADER_COMPONENT_IDS = ['header-a', 'header-b'] as const;
export type HeaderComponentId = (typeof HEADER_COMPONENT_IDS)[number];
export const FOOTER_COMPONENT_IDS = ['footer-a', 'footer-b'] as const;
export type FooterComponentId = (typeof FOOTER_COMPONENT_IDS)[number];

/** Body section types (order chosen by the model), 2 vetted variants each. */
export const BODY_COMPONENT_IDS = [
  'hero-a', 'hero-b',
  'services-a', 'services-b',
  'trust-a', 'trust-b',
  'contact-a', 'contact-b',
  'cta-a', 'cta-b',
] as const;
export type BodyComponentId = (typeof BODY_COMPONENT_IDS)[number];

/** The seven vetted section types. */
export const SECTION_TYPES = ['header', 'hero', 'services', 'trust', 'contact', 'cta_band', 'footer'] as const;
export type SectionType = (typeof SECTION_TYPES)[number];

/** Which section type a body component belongs to (drives ordering/uniqueness rules). */
export const BODY_COMPONENT_TYPE: Record<BodyComponentId, Exclude<SectionType, 'header' | 'footer'>> = {
  'hero-a': 'hero', 'hero-b': 'hero',
  'services-a': 'services', 'services-b': 'services',
  'trust-a': 'trust', 'trust-b': 'trust',
  'contact-a': 'contact', 'contact-b': 'contact',
  'cta-a': 'cta_band', 'cta-b': 'cta_band',
};

/** Hard cap on body sections per demo (MVP: 6). */
export const MAX_DEMO_SECTIONS = 6;

export interface DemoDesignSpecSection {
  componentId: BodyComponentId;
  /** 1-based placement order; unique across sections. */
  order: number;
  /** The accepted finding this section is meant to address, or null. Must resolve. */
  addressesFindingRef: string | null;
  /** Verified fact fields this section relies on. Must all be available. */
  factKeys: FactKey[];
  messagingEmphasis: MessagingEmphasis;
}

export interface DemoDesignSpec {
  visualDirection: VisualDirection;
  heroStrategy: HeroStrategy;
  headerVariant: HeaderComponentId;
  footerVariant: FooterComponentId;
  primaryCtaIntent: CtaIntent;
  primaryCtaLabelKey: CtaLabelKey;
  secondaryCtaEnabled: boolean;
  /** 1..MAX_DEMO_SECTIONS body sections; exactly one hero, placed first; contact required. */
  sections: DemoDesignSpecSection[];
  /** Ordering hint for mobile; a permutation/subset of the chosen section componentIds. */
  mobilePriority: BodyComponentId[];
  /** Short human-review rationale. Escaped for review display; NEVER rendered into the page. */
  rationale: string;
}

/** Adversarial reviewer verdict on a proposed spec (separate model call). */
export const REVIEW_DECISIONS = ['APPROVE', 'REVISE', 'REJECT'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export interface DemoDesignReview {
  decision: ReviewDecision;
  /** True ONLY for a narrow set of real fabrication risks (unsupported fact/finding
   * reference, invented business claim, services/trust/social-proof content unsupported by
   * facts, or a dishonest CTA destination). Empty factKeys alone is NOT fabrication. */
  fabricationRisk: boolean;
  /** True if every findingRef/factKey the spec cites is present in the brief. */
  evidenceConsistent: boolean;
  /** True if the CTA intent is honest given the verified facts (no fake booking). */
  ctaHonest: boolean;
  /** On a REVISE decision: does any requested revision need a NEW fact not in the brief? */
  revisionRequiresNewFacts: boolean;
  /** On a REVISE decision: does any requested revision need a NEW/invented business claim? */
  revisionRequiresNewClaims: boolean;
  /** On a REVISE decision: does any requested revision need the CTA destination changed? */
  revisionRequiresCtaChange: boolean;
  problems: string[];
}
