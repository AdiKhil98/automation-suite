import { createHash } from 'node:crypto';
import { type EvidenceObservation } from './evidence-types.js';

/** Stable, key-sorted JSON so identical logical input always hashes identically. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Reproducible per-item hash over the stable, non-volatile evidence fields + rules version. */
export function evidenceItemHash(obs: EvidenceObservation, rulesVersion: string): string {
  return sha256(
    stableStringify({
      rulesVersion,
      competitorCandidateId: obs.competitorCandidateId,
      evidenceCategory: obs.evidenceCategory,
      observationKind: obs.observationKind,
      sourcePageUrl: obs.sourcePageUrl,
      normalizedOrigin: obs.normalizedOrigin,
      selector: obs.selector,
      profile: obs.profile,
      numericValue: obs.numericValue,
      confidence: obs.confidence,
      // Excerpt normalized to lowercase so cosmetic whitespace/case never changes identity.
      excerpt: obs.sourceExcerpt ? obs.sourceExcerpt.toLowerCase() : null,
    }),
  );
}

/**
 * Content fingerprint over the full derived-observation set for a run (order-independent). Identical
 * page content + identical config yields a stable hash; materially changed content changes it, which
 * drives new-version creation. EXCLUDES capturedAt and any run identifiers (volatile).
 */
export function captureContentHash(observations: EvidenceObservation[], rulesVersion: string): string {
  const stable = observations
    .map((o) => evidenceItemHash(o, rulesVersion))
    .sort();
  return sha256(stableStringify({ rulesVersion, items: stable }));
}

/** Hash of the capture configuration (bounds + provider + rules version) for idempotency + audit. */
export function captureConfigHash(config: Record<string, unknown>, rulesVersion: string): string {
  return sha256(stableStringify({ rulesVersion, config }));
}

/** Hash of the eligible competitor input set (candidate identities + origins) for a run. */
export function captureInputHash(entries: ReadonlyArray<{ competitorCandidateId: string; normalizedOrigin: string }>): string {
  const sorted = [...entries].sort((a, b) => (a.competitorCandidateId < b.competitorCandidateId ? -1 : 1));
  return sha256(stableStringify(sorted));
}
