/**
 * Phase 7A3A deterministic confidence rules. Pattern confidence is a function of the usable
 * denominator, the participating (present-supporting) evidence confidences, and freshness (all
 * participating evidence is already FRESH by eligibility). Contrast confidence is bounded by the
 * lower of the pattern confidence and the prospect evidence confidence.
 */

import { type PatternConfidence } from './pattern-constants.js';

const RANK: Record<PatternConfidence, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

/** The weaker (lower) of two confidence bands. */
export function lowerConfidence(a: PatternConfidence, b: PatternConfidence): PatternConfidence {
  return RANK[a] <= RANK[b] ? a : b;
}

/**
 * Pattern confidence:
 *  - HIGH   : denominator === 3, every participating item HIGH, all fresh, presentCount >= 2
 *  - MEDIUM : denominator >= 2, every participating item HIGH|MEDIUM, all fresh
 *  - LOW    : anything weaker
 * `participatingConfidences` are the confidences of the eligible items backing the PRESENT brands.
 * `allFresh` is always true here (eligibility already enforces freshness) but is threaded explicitly
 * so the rule reads exactly as specified and stays correct if a caller relaxes eligibility.
 */
export function patternConfidence(
  denominator: number,
  presentCount: number,
  participatingConfidences: PatternConfidence[],
  allFresh: boolean,
): PatternConfidence {
  if (participatingConfidences.length === 0 || !allFresh) return 'LOW';
  const everyHigh = participatingConfidences.every((c) => c === 'HIGH');
  const everyHighOrMedium = participatingConfidences.every((c) => c === 'HIGH' || c === 'MEDIUM');
  if (denominator >= 3 && presentCount >= 2 && everyHigh) return 'HIGH';
  if (denominator >= 2 && everyHighOrMedium) return 'MEDIUM';
  return 'LOW';
}
