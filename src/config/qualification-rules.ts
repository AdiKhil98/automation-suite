import { hashCanonical } from '../utils/hash.js';

/**
 * Versioned, deterministic qualification rules. The exact config is hashed into
 * every result (`rulesConfigHash`) so rule drift is detectable. No AI, ever.
 */
export interface QualificationRules {
  version: string;
  ratingMin: number;
  reviewCountMin: number;
  viabilityWeights: {
    active: number;
    rating: number;
    reviews: number;
    independent: number;
  };
  contactabilityTiers: {
    verifiedEmail: number;
    contactForm: number;
    phone: number;
  };
  composite: { viability: number; auditability: number };
  acceptThreshold: number;
  priorityHigh: number;
}

export const QUALIFICATION_RULES: QualificationRules = {
  version: 'q-2026.07.1',
  ratingMin: 4.0,
  reviewCountMin: 20,
  viabilityWeights: { active: 40, rating: 25, reviews: 20, independent: 15 },
  contactabilityTiers: { verifiedEmail: 100, contactForm: 80, phone: 40 },
  composite: { viability: 0.6, auditability: 0.4 },
  acceptThreshold: 55,
  priorityHigh: 80,
};

export function rulesConfigHash(rules: QualificationRules): string {
  return hashCanonical(rules);
}
