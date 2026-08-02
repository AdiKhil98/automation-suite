/**
 * Phase 7A3A deterministic hashing for competitor pattern packages. Stable, key-sorted JSON so
 * identical logical input always hashes identically — this drives idempotency (same inputs reuse the
 * same version) and versioning (materially changed evidence produces a new version).
 */

import { createHash } from 'node:crypto';
import { type CompetitorPattern, type PatternBuildInput, type ProspectContrast } from './pattern-types.js';

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

/**
 * Input hash over the identity of what the package was built from: the prospect, the research run, the
 * capture runs, the selected competitor identities, and the EXACT eligible evidence item ids. Changing
 * the eligible evidence set (e.g. an item goes stale or is invalidated) changes this hash → new version.
 */
export function patternInputHash(input: PatternBuildInput, eligibleEvidenceIds: string[]): string {
  return sha256(
    stableStringify({
      leadId: input.leadId,
      researchRunId: input.researchRunId,
      captureRunIds: [...input.captureRunIds].sort(),
      selectedCompetitorIds: input.competitors.filter((c) => c.selected).map((c) => c.competitorCandidateId).sort(),
      eligibleEvidenceIds: [...eligibleEvidenceIds].sort(),
      prospectCaptureRunId: input.prospect.captureRunId,
      prospectEvidenceIds: input.prospect.refs.map((r) => r.id).sort(),
    }),
  );
}

/** Config hash over the rule versions + evaluation bounds (never the volatile `now`). */
export function patternConfigHash(rulesVersion: string, maxAgeDays: number): string {
  return sha256(stableStringify({ rulesVersion, maxAgeDays }));
}

/** Package hash over the produced patterns + contrasts (order-independent). */
export function patternPackageHash(patterns: CompetitorPattern[], contrasts: ProspectContrast[], rulesVersion: string): string {
  const patternKeys = patterns
    .map((p) =>
      stableStringify({
        category: p.category,
        result: p.result,
        presentCount: p.presentCount,
        absentCount: p.absentCount,
        unknownCount: p.unknownCount,
        usableDenominator: p.usableDenominator,
        totalSelected: p.totalSelected,
        confidence: p.confidence,
        wordingForm: p.wordingForm,
        consequenceLabel: p.consequenceLabel,
        numericMedian: p.numericMedian,
        evidenceItemIds: [...p.evidenceItemIds].sort(),
      }),
    )
    .sort();
  const contrastKeys = contrasts
    .map((c) => stableStringify({ category: c.category, prospectState: c.prospectState, confidence: c.confidence, consequenceLabel: c.consequenceLabel }))
    .sort();
  return sha256(stableStringify({ rulesVersion, patterns: patternKeys, contrasts: contrastKeys }));
}
