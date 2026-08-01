import { type CompetitorInputCandidate, type ProspectProfileInput } from '../../domain/competitor/types.js';

/** The only candidate-source providers permitted in Phase 7A1. No live provider exists here. */
export const ALLOWED_COMPETITOR_PROVIDERS = ['fixture', 'operator_csv'] as const;
export type CompetitorProviderName = (typeof ALLOWED_COMPETITOR_PROVIDERS)[number];

export interface CompetitorSourceResult {
  prospect: ProspectProfileInput | null;
  candidates: CompetitorInputCandidate[];
  errors: string[];
}

export interface CompetitorCandidateSource {
  readonly name: CompetitorProviderName;
  load(leadId: string): CompetitorSourceResult;
}

export class LiveProviderNotAllowedError extends Error {
  constructor(requested: string) {
    super(
      `Live competitor provider "${requested}" is not available in Phase 7A1. ` +
        `Allowed: ${ALLOWED_COMPETITOR_PROVIDERS.join(', ')}. There is no silent fallback to fixtures/mocks.`,
    );
    this.name = 'LiveProviderNotAllowedError';
  }
}

/**
 * Fail-closed provider guard. Any requested provider outside the allowed fixture/CSV set throws
 * (the CLI turns this into a nonzero exit). It NEVER silently degrades a live request to a fixture.
 */
export function assertAllowedProvider(requested: string): CompetitorProviderName {
  if ((ALLOWED_COMPETITOR_PROVIDERS as readonly string[]).includes(requested)) {
    return requested as CompetitorProviderName;
  }
  throw new LiveProviderNotAllowedError(requested);
}
