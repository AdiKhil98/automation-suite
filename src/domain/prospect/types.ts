export const PROSPECT_RANKS = ['POPULARITY', 'DISTANCE'] as const;
export type ProspectRank = (typeof PROSPECT_RANKS)[number];

export const PROSPECT_CANDIDATE_OUTCOMES = [
  'DISCOVERED', 'QUALIFIED', 'DUPLICATE', 'SUPPRESSED', 'NO_WEBSITE', 'CLOSED',
  'WEBSITE_TRANSIENT', 'WEBSITE_INVALID', 'DISQUALIFIED', 'MANUAL_REVIEW', 'SYSTEMIC_FAILURE',
] as const;
export type ProspectCandidateOutcome = (typeof PROSPECT_CANDIDATE_OUTCOMES)[number];

export interface ProspectInput {
  niche: string;
  location: string;
  radiusKm: number;
  targetQualified: number;
  maxCandidates: number;
  rankPreference: ProspectRank;
  latitude?: number;
  longitude?: number;
  continuePipeline: boolean;
}

export interface ResolvedProspectInput extends ProspectInput { niche: string; includedTypes: string[] }

export interface ResolvedLocation {
  latitude: number;
  longitude: number;
  formattedLocation: string;
  provider: 'manual' | 'google_places';
  resolvedAt: Date;
  externalRequests: number;
}

export interface ProspectExternalCalls {
  locationResolution: number;
  nearbySearch: number;
  placeDetails: number;
  websiteVerification: number;
}

export interface ProspectCandidateResult {
  outcome: Exclude<ProspectCandidateOutcome, 'DISCOVERED'>;
  leadId: string | null;
  reason: string;
  detailsRequests: number;
  websiteVerifications: number;
  failureStage?: string | null;
  failureCode?: string | null;
  failureElapsedMs?: number | null;
}

export type ProspectRunResult = 'TARGET_REACHED' | 'CANDIDATE_BUDGET_EXHAUSTED' | 'EXTERNAL_BUDGET_EXHAUSTED' | 'SYSTEMIC_FAILURE';

export interface ProspectRunSummary {
  runId: string;
  result: ProspectRunResult;
  discovered: number;
  processed: number;
  qualifiedLeadIds: string[];
  externalCalls: ProspectExternalCalls;
  circuitBreakerReason: string | null;
}
