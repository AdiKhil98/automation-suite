import {
  BODY_COMPONENT_TYPE,
  type CtaIntent,
  type CtaLabelKey,
  type DemoDesignSpec,
  type FactKey,
  MAX_DEMO_SECTIONS,
} from './design-spec.js';

export interface SpecValidationContext {
  /** Fact fields that resolve to a real verified value for this lead. */
  availableFactKeys: Set<FactKey>;
  /** findingRefs of the accepted (Phase 6) findings the spec may address. */
  findingRefs: Set<string>;
  /** Which CTA intents are honestly achievable given the verified facts. */
  achievableCtaIntents: Set<CtaIntent>;
}

export interface SpecValidationResult {
  ok: boolean;
  violations: string[];
}

/** Which label keys are allowed for a given CTA intent (prevents a "Book" label on a
 * non-booking destination). */
const LABEL_KEYS_FOR_INTENT: Record<CtaIntent, CtaLabelKey[]> = {
  booking: ['BOOK_APPOINTMENT', 'REQUEST_APPOINTMENT', 'GET_IN_TOUCH'],
  contact: ['CONTACT_US', 'REQUEST_APPOINTMENT', 'GET_IN_TOUCH'],
  call: ['CALL_US', 'GET_IN_TOUCH'],
  scroll: ['CONTACT_US', 'GET_IN_TOUCH'],
};

/**
 * Deterministic validation of a schema-valid DemoDesignSpec BEFORE any rendering. Enforces
 * structure, evidence/fact references, CTA honesty, section limits, and mobile requirements.
 * Nothing here trusts the model: every reference must resolve to real verified evidence, and
 * a spec that would imply fabricated or dishonest content is rejected.
 */
export function validateDesignSpec(spec: DemoDesignSpec, ctx: SpecValidationContext): SpecValidationResult {
  const violations: string[] = [];

  // --- Sections: count, hero-first, uniqueness, contiguous ordering ---
  if (spec.sections.length === 0) violations.push('no_sections');
  if (spec.sections.length > MAX_DEMO_SECTIONS) violations.push('too_many_sections');

  const types = spec.sections.map((s) => BODY_COMPONENT_TYPE[s.componentId]);
  const typeCounts = new Map<string, number>();
  for (const t of types) typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
  for (const [t, n] of typeCounts) if (n > 1) violations.push(`duplicate_section_type:${t}`);

  const heroCount = typeCounts.get('hero') ?? 0;
  if (heroCount !== 1) violations.push('hero_required_once');
  if (!typeCounts.has('contact')) violations.push('contact_section_required');

  const orders = spec.sections.map((s) => s.order).sort((a, b) => a - b);
  const contiguous = orders.every((o, i) => o === i + 1);
  if (!contiguous) violations.push('orders_not_contiguous');
  const hero = spec.sections.find((s) => BODY_COMPONENT_TYPE[s.componentId] === 'hero');
  if (hero && hero.order !== 1) violations.push('hero_not_first');

  // --- Per-section: finding refs, fact keys, required facts ---
  for (const s of spec.sections) {
    const type = BODY_COMPONENT_TYPE[s.componentId];
    if (s.addressesFindingRef !== null && !ctx.findingRefs.has(s.addressesFindingRef)) {
      violations.push(`unknown_finding_ref:${s.addressesFindingRef}`);
    }
    for (const fk of s.factKeys) {
      if (!ctx.availableFactKeys.has(fk)) violations.push(`unavailable_fact_key:${type}:${fk}`);
    }
    // A section whose whole purpose is a fact must have that fact available (no empty sections).
    if (type === 'services' && !ctx.availableFactKeys.has('services')) violations.push('services_section_without_services_fact');
    if (type === 'contact') {
      const hasAnyContact = (['phone', 'email', 'address', 'opening_hours', 'website'] as FactKey[]).some((k) => ctx.availableFactKeys.has(k));
      if (!hasAnyContact) violations.push('contact_section_without_contact_facts');
    }
  }

  // --- CTA honesty ---
  if (!ctx.achievableCtaIntents.has(spec.primaryCtaIntent)) {
    violations.push(`cta_intent_not_achievable:${spec.primaryCtaIntent}`);
  }
  if (!LABEL_KEYS_FOR_INTENT[spec.primaryCtaIntent].includes(spec.primaryCtaLabelKey)) {
    violations.push(`cta_label_intent_mismatch:${spec.primaryCtaLabelKey}:${spec.primaryCtaIntent}`);
  }

  // --- Mobile priority: only chosen components, no duplicates ---
  const chosen = new Set(spec.sections.map((s) => s.componentId));
  const seen = new Set<string>();
  for (const id of spec.mobilePriority) {
    if (!chosen.has(id)) violations.push(`mobile_priority_unknown_component:${id}`);
    if (seen.has(id)) violations.push(`mobile_priority_duplicate:${id}`);
    seen.add(id);
  }

  return { ok: violations.length === 0, violations };
}
