import { type AuditCategory } from '../audit/audit-types.js';

export const DEMO_TEMPLATE_ID = 'dental-classic';
export const DEMO_TEMPLATE_VERSION = 'demo-tpl-1';
export const DEMO_BRIEF_RULES_VERSION = 'demo-brief-1';

/** Demo lifecycle status. Generation is SEPARATE from approval (amendment 5): a fresh
 * demo is GENERATED_PENDING_REVIEW and must be human-approved before any later publish. */
export const DEMO_STATUSES = ['GENERATED_PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SUPERSEDED', 'BUILD_FAILED'] as const;
export type DemoStatus = (typeof DEMO_STATUSES)[number];

export type DemoDecisionKind = 'BUILD_DEMO' | 'NO_DEMO';

/** Per-lead demo run outcome. */
export const DEMO_OUTCOMES = [
  'DEMO_BUILT',
  'NO_DEMO_NOT_JUSTIFIED',
  'NO_DEMO_INSUFFICIENT_FACTS',
  'DEMO_BUILD_FAILED',
  'VALIDATION_FAILED',
  'DISABLED',
  'MANUAL_REVIEW_REQUIRED',
] as const;
export type DemoOutcome = (typeof DEMO_OUTCOMES)[number];

/** Demonstrable finding categories — ones a demo can visibly address. */
export const DEMONSTRABLE_CATEGORIES: readonly AuditCategory[] = [
  'CTA_CLARITY',
  'BOOKING_FRICTION',
  'CONTACT_FRICTION',
  'MOBILE_USABILITY',
  'TRUST_SIGNALS',
  'SOCIAL_PROOF',
  'SERVICE_CLARITY',
  'VISUAL_HIERARCHY',
  'LOCAL_INFORMATION',
];

/** Template emphasis directives derived deterministically from findings. */
export const DEMO_DIRECTIVES = ['PROMINENT_CTA', 'VISIBLE_CONTACT', 'RESPONSIVE', 'SERVICES_SECTION', 'CLEAR_HIERARCHY'] as const;
export type DemoDirective = (typeof DEMO_DIRECTIVES)[number];

/** A finding that drove a directive (for relational provenance). */
export interface FindingInput {
  findingId: string;
  findingRef: string;
  category: AuditCategory;
  directive: DemoDirective;
}

export interface DemoBrief {
  directives: DemoDirective[];
  findingInputs: FindingInput[];
}

/** Primary call-to-action. NEVER labelled as online booking without a verified booking
 * URL (amendment 2). `kind` records the resolved destination type. */
export type CtaKind = 'booking' | 'contact' | 'tel' | 'scroll';
export interface Cta {
  label: string;
  href: string; // sanitized; '#contact' for scroll
  kind: CtaKind;
}

/** Records that a rendered field/section drew its value from a specific lead fact. */
export interface FactInput {
  factId: string;
  factType: string;
  field: string; // e.g. 'business_name', 'contact.phone', 'cta.href'
}

/** Fully-resolved, provenance-tracked content model for the template. */
export interface DemoContent {
  businessName: string;
  city: string | null;
  officialWebsiteUrl: string | null;
  phoneTel: string | null;
  emailMailto: string | null;
  address: string | null;
  services: string[];
  cta: Cta;
  factInputs: FactInput[];
}

export interface BuiltDemo {
  html: string;
  netlifyToml: string;
  content: DemoContent;
  contentHash: string;
}
