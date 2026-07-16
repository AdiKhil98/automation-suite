import { type LeadFact } from '../lead-facts/lead-fact.js';
import { type DemoContent } from './demo-types.js';

export interface DemoValidationResult {
  ok: boolean;
  violations: string[];
}

/**
 * Content provenance + no-fabrication checks (amendments 2 & 4). Every business-specific
 * value must trace to a CURRENT verified fact; no fabricated sections may appear.
 */
export function validateDemoContent(content: DemoContent, facts: LeadFact[]): DemoValidationResult {
  const violations: string[] = [];
  const currentIds = new Set(facts.filter((f) => f.isCurrent).map((f) => f.id));

  if (!content.businessName || content.businessName.trim() === '') violations.push('missing_business_name');
  if (!content.factInputs.some((fi) => fi.field === 'business_name')) violations.push('business_name_not_from_fact');

  for (const fi of content.factInputs) {
    if (!currentIds.has(fi.factId)) violations.push(`fact_input_not_current:${fi.field}:${fi.factId}`);
  }
  // MVP fabricates nothing: services only come from facts (none exist yet).
  if (content.services.length > 0 && !content.factInputs.some((fi) => fi.field.startsWith('services'))) {
    violations.push('services_without_fact');
  }
  // A booking-implying CTA is only allowed with a verified booking destination.
  if (content.cta.kind === 'booking' && !content.factInputs.some((fi) => fi.field === 'cta.href')) {
    violations.push('booking_cta_without_verified_url');
  }
  return { ok: violations.length === 0, violations };
}

// Patterns are ANCHORED on real tags/attributes so that safely-ESCAPED fact text
// (e.g. "&lt;script&gt;", or literal "onerror=" inside escaped content) does NOT
// false-positive. A match therefore indicates genuine un-escaped injection — a bug.
const FORBIDDEN_HTML = [
  [/<script[\s>]/i, 'contains_script'],
  [/<\/script>/i, 'contains_script_close'],
  [/<form[\s>]/i, 'contains_form'],
  [/<iframe[\s>]/i, 'contains_iframe'],
  [/<object[\s>]/i, 'contains_object'],
  [/<embed[\s>]/i, 'contains_embed'],
  [/<[a-z][^>]*\son\w+\s*=/i, 'contains_inline_event_handler'],
  [/(?:href|src)\s*=\s*["']?\s*javascript:/i, 'contains_javascript_url'],
  [/\bsrc\s*=\s*["']?\s*data:/i, 'contains_data_uri_src'],
  [/<link[^>]+stylesheet/i, 'external_stylesheet'],
  [/<(?:img|script|link|iframe)[^>]+(?:src|href)\s*=\s*["']https?:\/\//i, 'external_resource_load'],
] as const;

/**
 * Rendered-HTML security checks (amendment 3). Rejects injected/executable markup,
 * external resource loads, or missing safety directives. External <a href="http…">
 * links (e.g. the business's own website) are allowed — they are navigations, not
 * auto-loading resources — so the external-resource rule targets img/script/link/iframe.
 * Escaped fact text is inert and passes; only genuine un-escaped injection fails.
 */
export function validateRenderedHtml(html: string): DemoValidationResult {
  const violations: string[] = [];
  for (const [re, label] of FORBIDDEN_HTML) {
    if (re.test(html)) violations.push(label);
  }
  if (!/name="robots"\s+content="noindex,nofollow,noarchive"/i.test(html)) violations.push('missing_noindex');
  if (!/Content-Security-Policy/i.test(html)) violations.push('missing_csp');
  if (!/concept redesign/i.test(html)) violations.push('missing_disclosure');
  if (!/class="cta"/i.test(html)) violations.push('missing_cta');
  return { ok: violations.length === 0, violations };
}
