import { NON_ELIGIBLE_DOMAINS } from './constants.js';
import { registrableDomain, normalizeDomain } from './normalize.js';
import { VerifiedOriginPolicy } from '../capture/verified-origin.js';

/**
 * Phase 7A2 capture eligibility. A competitor may be captured ONLY when it was selected by the named
 * Phase 7A1 run (disposition ACCEPTED, not superseded), has a valid normalized business website whose
 * origin passes VerifiedOriginPolicy, is not the prospect's own domain, and is not a
 * directory/marketplace/aggregator/social-only site. The origin is derived SOLELY from the stored
 * candidate's normalized domain — never from an operator-supplied URL — so an arbitrary origin can
 * never silently replace the approved one.
 */

export interface SelectedCompetitorInput {
  competitorCandidateId: string;
  disposition: string;
  normalizedDomain: string | null;
}

export interface EligibilityResult {
  competitorCandidateId: string;
  eligible: boolean;
  reason: string | null;
  normalizedOrigin: string | null;
  originUrl: string | null;
  originPolicy: VerifiedOriginPolicy | null;
}

export type EligibilityReason =
  | 'NOT_SELECTED'
  | 'INVALID_WEBSITE'
  | 'PROSPECT_DOMAIN'
  | 'NON_ELIGIBLE_LISTING'
  | 'ORIGIN_POLICY_REJECTED'
  | 'ORIGIN_SUBSTITUTION_REJECTED';

/** Build the competitor origin URL from its stored normalized domain (https, apex). */
function originFromDomain(domain: string): string {
  return `https://${domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '')}`;
}

export function evaluateEligibility(
  candidate: SelectedCompetitorInput,
  prospectNormalizedDomain: string | null,
  /** Optional caller-supplied origin; MUST match the candidate's registrable domain or it is rejected. */
  suppliedOriginUrl?: string | null,
): EligibilityResult {
  const base = {
    competitorCandidateId: candidate.competitorCandidateId,
    normalizedOrigin: null,
    originUrl: null,
    originPolicy: null,
  };
  const reject = (reason: EligibilityReason): EligibilityResult => ({ ...base, eligible: false, reason });

  if (candidate.disposition !== 'ACCEPTED') return reject('NOT_SELECTED');

  const domain = normalizeDomain(candidate.normalizedDomain);
  if (!domain) return reject('INVALID_WEBSITE');

  const registrable = registrableDomain(domain);
  if (!registrable) return reject('INVALID_WEBSITE');

  // Never allow an out-of-band URL to replace the approved origin: an override is honored only when it
  // resolves to the SAME registrable domain as the stored candidate.
  if (suppliedOriginUrl) {
    const suppliedReg = registrableDomain(suppliedOriginUrl);
    if (!suppliedReg || suppliedReg !== registrable) return reject('ORIGIN_SUBSTITUTION_REJECTED');
  }

  const prospectReg = prospectNormalizedDomain ? registrableDomain(prospectNormalizedDomain) : null;
  if (prospectReg && prospectReg === registrable) return reject('PROSPECT_DOMAIN');

  if (NON_ELIGIBLE_DOMAINS.has(registrable)) return reject('NON_ELIGIBLE_LISTING');

  const originUrl = originFromDomain(domain);
  const originPolicy = new VerifiedOriginPolicy({
    officialDomain: registrable,
    officialWebsiteUrl: originUrl,
    officialLocationPageUrl: null,
  });
  const decision = originPolicy.isAllowedMainFrame(originUrl);
  if (!decision.allowed) return reject('ORIGIN_POLICY_REJECTED');

  return {
    competitorCandidateId: candidate.competitorCandidateId,
    eligible: true,
    reason: null,
    normalizedOrigin: registrable,
    originUrl,
    originPolicy,
  };
}
