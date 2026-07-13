import { type FactType } from '../lead-facts/lead-fact.js';
import { type CandidateDecision, type DiscoverySource, type SignalType } from './outcome.js';

/**
 * In-memory only context used to discover/verify a website. May originate from a
 * provider that returns provider-restricted data (e.g. Google); it is NEVER
 * persisted and must be re-verified against the official site before storage.
 */
export interface EnrichmentContext {
  businessName?: string | null;
  phone?: string | null;
  formattedAddress?: string | null;
  city?: string | null;
  country?: string | null;
  candidateUrls?: string[];
}

export interface Candidate {
  url: string;
  discoverySource: DiscoverySource;
}

/** JSON-LD business entity extracted from a page (schema.org). */
export interface StructuredBusiness {
  type: string;
  name?: string;
  telephone?: string;
  streetAddress?: string;
  addressLocality?: string;
}

/** Deterministic extraction result for a single fetched page. No raw HTML retained. */
export interface ExtractedPage {
  requestedUrl: string;
  finalUrl: string;
  host: string;
  httpStatus: number;
  title: string | null;
  visibleTextLength: number;
  visibleTextSample: string; // bounded lower-cased sample for deterministic matching (not persisted)
  scriptCount: number;
  hasEmptyAppRoot: boolean;
  phones: string[]; // from tel: and visible text
  emails: string[]; // from mailto: and visible text
  contactFormUrls: string[];
  structured: StructuredBusiness[];
  sameOriginLinks: Array<{ href: string; text: string }>;
  legalText: string | null; // footer/legal identity line
}

/** One structured piece of verification evidence. Never contains full HTML. */
export interface VerificationSignal {
  signalType: SignalType;
  pageUrl: string;
  matchedFactType: FactType | null;
  extractedValue: string;
  normalizedValue: string | null;
  selector: string | null;
  confidence: number;
  strong: boolean;
}

/** A durable fact to write, extracted + verified from the official site. */
export interface ExtractedFact {
  factType: FactType;
  value: string;
  normalizedValue: string | null;
  sourceUrl: string;
  confidence: number;
}

/** Per-candidate verification outcome. */
export interface CandidateVerification {
  requestedUrl: string;
  finalUrl: string | null;
  host: string | null;
  httpStatus: number | null;
  discoverySource: DiscoverySource;
  isDirectory: boolean;
  decision: CandidateDecision;
  confidence: number;
  rejectedReason: string | null;
  signals: VerificationSignal[];
  facts: ExtractedFact[];
  browserRequired: boolean;
}
