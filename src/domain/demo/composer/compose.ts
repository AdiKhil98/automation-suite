import { hashCanonical } from '../../../utils/hash.js';
import { type LeadFact } from '../../lead-facts/lead-fact.js';
import { resolveDemoContent } from '../demo-content.js';
import { escapeHtml, sanitizeUrl } from '../sanitize.js';
import { renderNetlifyToml } from '../template.js';
import { validateRenderedHtml } from '../demo-validation.js';
import { type CtaKind, type DemoContent, type FactInput } from '../demo-types.js';
import {
  BODY_COMPONENT_TYPE,
  type CtaIntent,
  type CtaLabelKey,
  type DemoDesignSpec,
  type FactKey,
} from './design-spec.js';
import {
  BODY_COMPONENTS,
  COMPOSER_TEMPLATE_ID,
  COMPOSER_TEMPLATE_VERSION,
  type ComponentInput,
  FOOTERS,
  HEADERS,
  pageStyle,
  type ResolvedCta,
} from './components.js';
import { validateDesignSpec, type SpecValidationContext, type SpecValidationResult } from './spec-validation.js';

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";
const DISCLOSURE = (name: string): string =>
  `Concept redesign for demonstration only — not affiliated with, endorsed by, or the official website of ${name}.`;

const CTA_LABEL_TEXT: Record<CtaLabelKey, string> = {
  BOOK_APPOINTMENT: 'Book an appointment',
  REQUEST_APPOINTMENT: 'Request an appointment',
  CONTACT_US: 'Contact us',
  CALL_US: 'Call us',
  GET_IN_TOUCH: 'Get in touch',
};

const current = (facts: LeadFact[], t: string): LeadFact | undefined =>
  facts.find((f) => f.factType === t && f.isCurrent && f.value.trim() !== '');

/** Accepted (Phase 6) finding available for a section to address. */
export interface ComposerFinding {
  id: string;
  findingRef: string;
  category: string;
  safeForOutreach: boolean;
}

export interface ComposeInput {
  facts: LeadFact[];
  findings: ComposerFinding[];
}

export interface ComposedDemo {
  html: string;
  netlifyToml: string;
  contentHash: string;
  content: DemoContent;
  ctaKind: CtaKind;
  componentIds: string[];
  factInputs: FactInput[];
  findingInputs: { findingId: string; findingRef: string; directive: string }[];
}

export type ComposeOutcome = 'DEMO_COMPOSED' | 'SPEC_INVALID' | 'RENDER_INVALID';

export interface ComposeResult {
  outcome: ComposeOutcome;
  violations: string[];
  built?: ComposedDemo;
}

/** Fact fields + honest CTA intents available for this lead. Used to validate a spec
 * against real evidence before rendering, and shared with the renderer. */
export function buildSpecContext(facts: LeadFact[], safeFindingRefs: string[]): SpecValidationContext {
  const content = resolveDemoContent(facts);
  const bookingHref = sanitizeUrl(current(facts, 'booking_url')?.value);
  const contactHref = sanitizeUrl(current(facts, 'contact_form_url')?.value);

  const availableFactKeys = new Set<FactKey>();
  if (content.businessName) availableFactKeys.add('business_name');
  if (content.city) availableFactKeys.add('city');
  if (content.phoneTel) availableFactKeys.add('phone');
  if (content.emailMailto) availableFactKeys.add('email');
  if (content.address) availableFactKeys.add('address');
  if (content.openingHours.length > 0) availableFactKeys.add('opening_hours');
  if (content.services.length > 0) availableFactKeys.add('services');
  if (content.officialWebsiteUrl) availableFactKeys.add('website');
  if (bookingHref) availableFactKeys.add('booking_url');

  const achievableCtaIntents = new Set<CtaIntent>(['scroll']);
  if (bookingHref) achievableCtaIntents.add('booking');
  if (contactHref) achievableCtaIntents.add('contact');
  if (content.phoneTel) achievableCtaIntents.add('call');

  return { availableFactKeys, findingRefs: new Set(safeFindingRefs), achievableCtaIntents };
}

/** Resolve the primary CTA honestly from verified facts, honouring the (already-validated)
 * intent. Returns the destination + kind + the fact it drew from (for provenance). */
function resolvePrimaryCta(
  spec: DemoDesignSpec,
  facts: LeadFact[],
  content: DemoContent,
): { cta: ResolvedCta; kind: CtaKind; factInput: FactInput | null } {
  const label = CTA_LABEL_TEXT[spec.primaryCtaLabelKey];
  if (spec.primaryCtaIntent === 'booking') {
    const f = current(facts, 'booking_url');
    const href = f ? sanitizeUrl(f.value) : null;
    if (f && href) return { cta: { label, href }, kind: 'booking', factInput: { factId: f.id, factType: f.factType, field: 'cta.href' } };
  }
  if (spec.primaryCtaIntent === 'contact') {
    const f = current(facts, 'contact_form_url');
    const href = f ? sanitizeUrl(f.value) : null;
    if (f && href) return { cta: { label, href }, kind: 'contact', factInput: { factId: f.id, factType: f.factType, field: 'cta.href' } };
  }
  if (spec.primaryCtaIntent === 'call' && content.phoneTel) {
    const f = current(facts, 'phone');
    return { cta: { label, href: content.phoneTel }, kind: 'tel', factInput: f ? { factId: f.id, factType: f.factType, field: 'cta.href' } : null };
  }
  // Scroll intent (or a defensive fallback). Validation restricts the label key to a
  // scroll-appropriate one, so `label` never implies booking/calling here.
  const scrollLabel = spec.primaryCtaIntent === 'scroll' ? label : 'Get in touch';
  return { cta: { label: scrollLabel, href: '#contact' }, kind: 'scroll', factInput: null };
}

/**
 * Deterministically render a VALIDATED design spec into a demo page using ONLY the vetted
 * component library. Re-validates the spec (defence in depth), resolves an honest CTA,
 * assembles the chosen components in order, tracks relational provenance for every
 * personalized value, and runs the shared rendered-HTML security checks. No AI, no network,
 * no filesystem — identical inputs produce an identical page (content hash).
 */
export function composeDemo(spec: DemoDesignSpec, input: ComposeInput): ComposeResult {
  const safeFindings = input.findings.filter((f) => f.safeForOutreach);
  const ctx = buildSpecContext(input.facts, safeFindings.map((f) => f.findingRef));
  const specCheck: SpecValidationResult = validateDesignSpec(spec, ctx);
  if (!specCheck.ok) return { outcome: 'SPEC_INVALID', violations: specCheck.violations };

  const content = resolveDemoContent(input.facts);
  const displayName = content.businessName || 'this business';
  const name = escapeHtml(content.businessName || 'Dental practice');

  const sections = [...spec.sections].sort((a, b) => a.order - b.order);
  const hasServicesSection = sections.some((s) => BODY_COMPONENT_TYPE[s.componentId] === 'services');

  const { cta, kind: ctaKind, factInput: ctaFactInput } = resolvePrimaryCta(spec, input.facts, content);

  // Secondary "Call us" button: only with a verified phone and a non-call primary CTA.
  let secondaryFactInput: FactInput | null = null;
  let secondaryCtaHtml = '';
  if (spec.secondaryCtaEnabled && content.phoneTel && spec.primaryCtaIntent !== 'call') {
    secondaryCtaHtml = `<a class="cta secondary" href="${escapeHtml(content.phoneTel)}">Call us</a>`;
    const f = current(input.facts, 'phone');
    if (f) secondaryFactInput = { factId: f.id, factType: f.factType, field: 'cta.secondary' };
  }

  const componentIds: string[] = [spec.headerVariant];
  const bodyHtml = sections
    .map((s) => {
      componentIds.push(s.componentId);
      const ci: ComponentInput = { content, emphasis: s.messagingEmphasis, heroStrategy: spec.heroStrategy, cta, secondaryCtaHtml };
      return BODY_COMPONENTS[s.componentId](ci);
    })
    .join('\n');
  componentIds.push(spec.footerVariant);

  const headerHtml = HEADERS[spec.headerVariant](name, hasServicesSection);
  const footerHtml = FOOTERS[spec.footerVariant](name, DISCLOSURE(displayName));

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>${name} — concept redesign (demo)</title>
<style>${pageStyle(spec.visualDirection)}</style>
</head>
<body>
<div class="disclaimer">Concept demo — not the official website of ${escapeHtml(displayName)}.</div>
${headerHtml}
${bodyHtml}
${footerHtml}
</body>
</html>
`;

  const renderCheck = validateRenderedHtml(html);
  if (!renderCheck.ok) return { outcome: 'RENDER_INVALID', violations: renderCheck.violations };

  // Relational provenance: keep only values that actually rendered. resolveDemoContent
  // records the standard fields; the contact section (required) renders phone/email/
  // address/hours/website when present; services render only when a services section is
  // chosen. Replace resolveDemoContent's own CTA provenance with the spec-resolved CTA.
  let factInputs = content.factInputs.filter((fi) => fi.field !== 'cta.href');
  if (!hasServicesSection) factInputs = factInputs.filter((fi) => fi.field !== 'services');
  if (ctaFactInput) factInputs.push(ctaFactInput);
  if (secondaryFactInput) factInputs.push(secondaryFactInput);

  const findingById = new Map(safeFindings.map((f) => [f.findingRef, f]));
  const findingInputs: ComposedDemo['findingInputs'] = [];
  for (const s of sections) {
    if (s.addressesFindingRef === null) continue;
    const f = findingById.get(s.addressesFindingRef);
    if (!f) continue; // already rejected by validation; defensive
    findingInputs.push({ findingId: f.id, findingRef: f.findingRef, directive: `${BODY_COMPONENT_TYPE[s.componentId]}:${s.messagingEmphasis}` });
  }

  const contentHash = hashCanonical({ html, template: COMPOSER_TEMPLATE_ID, version: COMPOSER_TEMPLATE_VERSION });
  return {
    outcome: 'DEMO_COMPOSED',
    violations: [],
    built: { html, netlifyToml: renderNetlifyToml(), contentHash, content, ctaKind, componentIds, factInputs, findingInputs },
  };
}

export { COMPOSER_TEMPLATE_ID, COMPOSER_TEMPLATE_VERSION };
