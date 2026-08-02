/**
 * Phase 7A3A deterministic anonymized wording. A pure count→phrase map. NO AI, NO competitor names,
 * NO market/leader/best/performance language. The phrase is metadata for a LATER (unbuilt) email
 * milestone; 7A3A composes no email.
 */

import { type WordingForm } from './pattern-constants.js';

/** Deterministic wording form from exact present/denominator counts (booleans patterns only). */
export function wordingFormFor(presentCount: number, denominator: number): WordingForm {
  if (denominator === 2 && presentCount === 2) return 'TWO_OF_TWO';
  if (denominator === 3 && presentCount === 3) return 'ALL_OF_THREE';
  if (denominator === 3 && presentCount === 2) return 'TWO_OF_THREE';
  return 'NONE';
}

/**
 * Anonymized subject phrase for a wording form. Uses neutral "comparable nearby clinics / local
 * businesses" language only — never a competitor name, never a superlative, never performance.
 */
export function wordingTextFor(form: WordingForm): string | null {
  switch (form) {
    case 'TWO_OF_TWO':
      return 'two nearby clinics';
    case 'TWO_OF_THREE':
      return 'two of three comparable nearby clinics';
    case 'ALL_OF_THREE':
      return 'all three comparable nearby clinics';
    case 'NONE':
      return null;
  }
}
