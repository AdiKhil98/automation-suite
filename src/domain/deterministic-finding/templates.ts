import { type AuditCategory } from '../audit/audit-types.js';

/**
 * Fixed, structured templates for deterministic findings. The operator NEVER supplies free-form
 * observation/recommendation text — only a category — and the exact wording is drawn from here. This
 * is the mechanism that guarantees "no free-form unsupported claims".
 *
 * Wording rules encoded below:
 *  - The observation is explicitly scoped to the captured evidence ("On the pages reviewed …"). It
 *    must NOT assert an unrestricted, site-wide "no online booking" claim, because only bounded pages
 *    were captured (see evidence-support for what the evidence must positively show).
 *  - The recommendation is a neutral, non-quantified suggestion (no revenue/conversion/loss framing).
 */
export interface DeterministicFindingTemplate {
  category: AuditCategory;
  observation: string;
  recommendation: string;
}

const BOOKING_FRICTION: DeterministicFindingTemplate = {
  category: 'BOOKING_FRICTION',
  observation:
    "On the pages reviewed, the site's booking controls lead to a contact page rather than a direct online scheduling flow.",
  recommendation:
    'Add a direct online appointment-booking path so visitors can start scheduling on the website instead of switching to a contact form.',
};

/**
 * The categories a deterministic finding may currently be approved for. Intentionally narrow: only
 * BOOKING_FRICTION is enabled. Adding a category requires a new template + support rule + denylist review.
 */
const TEMPLATES: Readonly<Record<string, DeterministicFindingTemplate>> = {
  BOOKING_FRICTION,
};

export const SUPPORTED_DETERMINISTIC_CATEGORIES: readonly AuditCategory[] = Object.keys(TEMPLATES) as AuditCategory[];

export function isSupportedDeterministicCategory(category: string): category is AuditCategory {
  return Object.prototype.hasOwnProperty.call(TEMPLATES, category);
}

/** Returns the fixed template for a supported category, or null if the category is not enabled. */
export function getDeterministicTemplate(category: string): DeterministicFindingTemplate | null {
  return isSupportedDeterministicCategory(category) ? TEMPLATES[category] ?? null : null;
}
