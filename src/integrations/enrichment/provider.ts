import { type LeadFact } from '../../domain/lead-facts/lead-fact.js';
import { type Candidate, type CandidateVerification, type EnrichmentContext } from '../../domain/enrichment/types.js';
import {
  type FetchFinalClassification,
  type FetchOutcome,
} from '../../utils/safe-fetch.js';
import { type VerificationFailureStage } from '../../utils/network-error-classification.js';

/** Operator-supplied enrichment input (CLI/CSV). */
export interface ManualInput {
  candidateUrls?: string[];
  businessName?: string | null;
  phone?: string | null;
  formattedAddress?: string | null;
  city?: string | null;
  country?: string | null;
}

/** Everything a provider may read about a lead. */
export interface LeadEnrichmentInput {
  leadId: string;
  placeId: string | null;
  currentFacts: LeadFact[];
  manual?: ManualInput;
}

/** Self-describing provider contract (persistence + cost posture). */
export interface ProviderCapabilities {
  returnsFields: string[];
  persistableFields: string[]; // fields whose values MAY be persisted
  ephemeralFields: string[]; // fields that must stay in memory only
  canIncurCost: boolean;
  maxRequestsPerRun?: number;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface EnrichmentContextProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  contextFor(input: LeadEnrichmentInput): Promise<EnrichmentContext | null>;
}

export interface CandidateProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  candidatesFor(input: LeadEnrichmentInput, context: EnrichmentContext): Promise<Candidate[]>;
}

/** Injectable HTML fetcher so tests never touch the network. */
export interface PageFetcher {
  fetch(url: string): Promise<FetchOutcome>;
}

export interface VerifyReport {
  verifications: CandidateVerification[];
  fetchKinds: Array<FetchOutcome['kind']>;
  fetchAttempts: WebsiteVerificationAttempt[];
}

export interface WebsiteVerificationAttempt {
  candidateUrl: string;
  hostname: string | null;
  attemptedAt: Date;
  finalClassification: FetchFinalClassification;
  failureStage: VerificationFailureStage | null;
  errorCode: string | null;
  httpStatus: number | null;
  redirectCount: number;
  elapsedMs: number;
  resolvedIpFamily: 4 | 6 | null;
  retryable: boolean;
}

export interface WebsiteVerifier {
  verify(candidates: Candidate[], context: EnrichmentContext): Promise<VerifyReport>;
}
