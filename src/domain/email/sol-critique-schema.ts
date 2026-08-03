/**
 * Phase 7A4B — Sol ADVISORY comparative-critique schema. Sol compares the prospect-only BASELINE with the
 * deterministically ENRICHED email and returns a strict structured judgement. It is ADVISORY ONLY: it can
 * never modify an email, approve a package, trigger regeneration, override a deterministic safety gate, or
 * draft/send anything. Routed through the existing `LlmProvider` boundary as `task: 'email_review'` with the
 * dedicated `schemaName` below — the closed production task union is NOT modified (U2, option a).
 */

import { z } from 'zod';

/** Distinct schema name so the provider/critique path is unambiguous while reusing task: 'email_review'. */
export const SOL_CRITIQUE_SCHEMA_NAME = 'email_comparative_critique';

export const SOL_PREFERRED_VERSIONS = ['BASELINE', 'ENRICHED', 'TIE'] as const;
export const SOL_ADVISORY_VERDICTS = ['PASS', 'REVISE', 'FAIL'] as const;

export const solCritiqueSchema = z.object({
  preferredVersion: z.enum(SOL_PREFERRED_VERSIONS),
  baselineQualityScore: z.number().int().min(0).max(100),
  enrichedQualityScore: z.number().int().min(0).max(100),
  naturalnessAssessment: z.string().trim().min(1).max(600),
  credibilityAssessment: z.string().trim().min(1).max(600),
  flowAssessment: z.string().trim().min(1).max(600),
  mechanicalWordingDetected: z.boolean(),
  unsupportedClaimSuspected: z.boolean(),
  criticalIssues: z.array(z.string().trim().min(1).max(300)).max(20),
  improvementSuggestions: z.array(z.string().trim().min(1).max(300)).max(20),
  advisoryVerdict: z.enum(SOL_ADVISORY_VERDICTS),
});
export type SolCritiqueParsed = z.infer<typeof solCritiqueSchema>;

const strictObject = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: 'object',
  additionalProperties: false,
  required,
  properties,
});

export const SOL_CRITIQUE_JSON_SCHEMA = strictObject(
  {
    preferredVersion: { type: 'string', enum: [...SOL_PREFERRED_VERSIONS] },
    baselineQualityScore: { type: 'integer', minimum: 0, maximum: 100 },
    enrichedQualityScore: { type: 'integer', minimum: 0, maximum: 100 },
    naturalnessAssessment: { type: 'string' },
    credibilityAssessment: { type: 'string' },
    flowAssessment: { type: 'string' },
    mechanicalWordingDetected: { type: 'boolean' },
    unsupportedClaimSuspected: { type: 'boolean' },
    criticalIssues: { type: 'array', items: { type: 'string' } },
    improvementSuggestions: { type: 'array', items: { type: 'string' } },
    advisoryVerdict: { type: 'string', enum: [...SOL_ADVISORY_VERDICTS] },
  },
  [
    'preferredVersion', 'baselineQualityScore', 'enrichedQualityScore', 'naturalnessAssessment',
    'credibilityAssessment', 'flowAssessment', 'mechanicalWordingDetected', 'unsupportedClaimSuspected',
    'criticalIssues', 'improvementSuggestions', 'advisoryVerdict',
  ],
);

/** Sol rates the enriched email "materially worse" when it trails the baseline by a full 10-point band. */
export const SOL_MATERIALLY_WORSE_MARGIN = 10;

export function solRatesEnrichedMateriallyWorse(critique: SolCritiqueParsed): boolean {
  return critique.enrichedQualityScore <= critique.baselineQualityScore - SOL_MATERIALLY_WORSE_MARGIN;
}
