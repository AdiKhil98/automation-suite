import { DEMO_URL_TOKEN } from '../email/email-types.js';

/** Snapshot of everything the eligibility gate inspects (all from persisted state). */
export interface EligibilitySnapshot {
  leadStatus: string;
  demo: { status: string; contentHash: string | null } | null;
  email: { humanDecision: string | null; ctaKind: string; body: string } | null;
  /** True if the demo artifact files exist locally. */
  artifactPresent: boolean;
  /** Recomputed hash of the on-disk artifact, or null if unreadable. */
  recomputedArtifactHash: string | null;
  featureEnabled: boolean;
  credentialsConfigured: boolean;
  /** True if a VERIFIED deployment already exists for this site + artifact hash. */
  existingVerifiedForArtifact: boolean;
}

export interface EligibilityResult {
  eligible: boolean;
  /** True when a prior verified deployment for the same site+artifact can be reused. */
  duplicateReusable: boolean;
  reasons: string[];
}

/**
 * Deterministic deployment eligibility gate (fail-closed). A demo is deployed only when ALL
 * conditions hold. Demo approval and email wording approval are BOTH required but remain
 * independent facts. A prior verified deployment for the same site + artifact hash is reused
 * rather than re-deployed.
 */
export function checkEligibility(s: EligibilitySnapshot): EligibilityResult {
  const reasons: string[] = [];

  if (!s.featureEnabled) reasons.push('feature_disabled');
  if (!s.credentialsConfigured) reasons.push('credentials_missing');
  if (s.leadStatus !== 'WAITING_FOR_DEMO_URL') reasons.push(`lead_not_waiting:${s.leadStatus}`);

  if (!s.demo) reasons.push('no_demo');
  else if (s.demo.status !== 'APPROVED') reasons.push(`demo_not_human_approved:${s.demo.status}`);

  if (!s.email) reasons.push('no_email');
  else {
    if (s.email.humanDecision !== 'APPROVED') reasons.push(`email_wording_not_approved:${s.email.humanDecision ?? 'none'}`);
    if (s.email.ctaKind !== 'demo_link') reasons.push(`email_cta_not_demo_link:${s.email.ctaKind}`);
    const tokens = s.email.body.split(DEMO_URL_TOKEN).length - 1;
    if (tokens !== 1) reasons.push(`email_placeholder_count:${String(tokens)}`);
  }

  if (!s.artifactPresent) reasons.push('artifact_missing');
  if (s.recomputedArtifactHash === null) reasons.push('artifact_unreadable');
  else if (!s.demo?.contentHash) reasons.push('demo_hash_missing');
  else if (s.recomputedArtifactHash !== s.demo.contentHash) reasons.push('artifact_hash_mismatch');

  // A prior verified deployment for the same artifact is a REUSE, not a failure.
  if (s.existingVerifiedForArtifact) {
    return { eligible: false, duplicateReusable: true, reasons: ['duplicate_verified_exists'] };
  }

  return { eligible: reasons.length === 0, duplicateReusable: false, reasons };
}
