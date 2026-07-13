import { type FactSourceType, type LeadFact } from '../lead-facts/lead-fact.js';
import { type ExtractedFact } from './types.js';

export type FactWriteAction = 'insert' | 'noop' | 'supersede' | 'conflict';

export interface FactResolution {
  action: FactWriteAction;
  routeManualReview: boolean;
}

// Provenance strength: a verified website beats manual entry beats collected mock data.
function strength(source: FactSourceType): number {
  return source === 'website' ? 3 : source === 'manual' ? 2 : 1;
}

/**
 * Decide how a newly verified (website) fact relates to the current fact.
 * - same value            → noop (attach evidence to the existing fact)
 * - conflict with manual   → never auto-supersede; preserve manual, route to review
 * - stronger provenance    → supersede (preserving history)
 * - same provenance        → supersede only if strictly more confident
 * - weaker                 → noop
 */
export function resolveFactWrite(
  existing: LeadFact | null,
  incoming: ExtractedFact,
  incomingSource: FactSourceType = 'website',
): FactResolution {
  if (!existing) return { action: 'insert', routeManualReview: false };

  const existingNorm = existing.normalizedValue ?? existing.value;
  const incomingNorm = incoming.normalizedValue ?? incoming.value;
  if (existingNorm === incomingNorm) return { action: 'noop', routeManualReview: false };

  if (existing.sourceType === 'manual') return { action: 'conflict', routeManualReview: true };

  const inS = strength(incomingSource);
  const exS = strength(existing.sourceType);
  if (inS > exS) return { action: 'supersede', routeManualReview: false };
  if (inS === exS) {
    return incoming.confidence > existing.confidence
      ? { action: 'supersede', routeManualReview: false }
      : { action: 'noop', routeManualReview: false };
  }
  return { action: 'noop', routeManualReview: false };
}
