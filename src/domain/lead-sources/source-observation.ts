import { type MatchTier } from '../leads/dedup.js';

/** How a single candidate was processed within a request. */
export type ProcessingResult = 'CREATED' | 'DUPLICATE' | 'REFRESHED' | 'AMBIGUOUS';

/** Match tier including PLACE_ID (handled by entity identity, outside decideMatch). */
export type ObservationMatchTier = MatchTier | 'PLACE_ID';

/**
 * One candidate-processing result, referencing both the entity it resolved to and
 * the request it came from. run_id is intentionally NOT stored here — it is
 * reachable through the request.
 */
export interface NewSourceObservation {
  sourceEntityId: string;
  sourceRequestId: string;
  processingResult: ProcessingResult;
  matchTier: ObservationMatchTier | null;
}

export interface SourceObservation extends NewSourceObservation {
  id: string;
  observedAt: Date;
}
