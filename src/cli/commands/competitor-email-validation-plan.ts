/**
 * Phase 7A4A — `competitor-email-validation-plan`: read-only. Prints the synthetic scenario, the exact
 * pipeline stages, the rubric weights, the acceptance thresholds, and the hard safety gates. Performs
 * ZERO writes, no network, no database, no live model, no Gmail/Sheets.
 */

import {
  competitorCandidates,
  prospectProfile,
  SCENARIO_LABEL,
  safeFindings,
  syntheticProspectNegative,
} from '../../fixtures/competitor-email-validation/synthetic-dental-scenario.js';
import { ACCEPTANCE, RUBRIC_WEIGHTS } from '../../evaluation/email/constants.js';

const STAGES: readonly string[] = [
  '1. Phase 7A1 candidate normalization, scoring and selection (real service)',
  '2. Phase 7A2 fixture capture + deterministic evidence rules (real service, mock provider)',
  '3. Phase 7A3A pattern generation (real service)',
  '4. package validation + explicit synthetic operator approval (real gates; DRAFT → APPROVED)',
  '5. composition-time revalidation (recompute package + hash re-match + freshness recheck)',
  '6. Phase 7A3B prospect-only BASELINE + ENRICHED composition (same base draft)',
  '7. deterministic final validators + traceability + message hashing',
  '8. deterministic 100-point quality rubric over both emails',
  '9. hard safety gates (safety overrides score)',
  '10. side-by-side report → PASS / REVISE / FAIL',
];

const HARD_GATES: readonly string[] = [
  'unsupported prospect/competitor claim', 'wrong competitor count', 'sample-of-one comparison',
  'competitor identity/domain leakage', 'stale/unsafe/invalidated/superseded evidence', 'package hash mismatch',
  'missing claim traceability', 'prohibited performance/conversion/revenue/ranking/volume claim',
  'competitor context in subject', 'competitor section before prospect observation', 'more than one competitor section',
  'unsupported consequence', 'final schema not email-copy-schema-3',
  'final competitor_evidence_used not APPROVED_COMPETITOR_PATTERN_PACKAGE', 'unstable claim spans or message hash',
];

export function competitorEmailValidationPlanCommand(): void {
  console.log(`\n=== Competitor Email Quality Validation — PLAN (read-only) ===`);
  console.log(`scenario: ${SCENARIO_LABEL} (SYNTHETIC, fictional; no real company/domain/person)`);
  console.log(`\nProspect: fictional ${prospectProfile.primaryCategory ?? ''} in ${prospectProfile.city ?? ''} (${prospectProfile.market ?? ''}/${prospectProfile.language ?? ''})`);
  console.log(`Primary issue: ${safeFindings[0]!.category} (${safeFindings[0]!.findingRef}) — mobile booking discoverability`);
  console.log(`Explicit synthetic prospect negative: ${syntheticProspectNegative.category} ${syntheticProspectNegative.polarity} @ ${syntheticProspectNegative.viewport}`);
  console.log(`Comparable competitors: ${String(competitorCandidates.length)} fictional clinics (valid booking pattern expected)`);

  console.log('\nPipeline stages:');
  for (const s of STAGES) console.log(`  ${s}`);

  console.log('\nRubric weights (sum 100):');
  for (const [k, v] of Object.entries(RUBRIC_WEIGHTS)) console.log(`  ${k.padEnd(22)} ${String(v)}`);

  console.log('\nEnriched acceptance:');
  console.log(`  total >= ${String(ACCEPTANCE.minTotal)}; enriched >= baseline + ${String(ACCEPTANCE.minImprovementOverBaseline)}; no zero category;`);
  console.log(`  integrity = ${String(ACCEPTANCE.requiredIntegrity)}/20; material relevance >= ${String(ACCEPTANCE.minMaterialRelevance)}/20; all hard gates pass.`);

  console.log('\nHard safety gates (any failure => FAIL, overriding the score):');
  for (const g of HARD_GATES) console.log(`  • ${g}`);

  console.log('\nfixture-only and offline. No network, database, live model, Gmail, Sheets, draft, or send.');
}
