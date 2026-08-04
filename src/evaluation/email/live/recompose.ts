/**
 * Phase 7A4B2 — offline RECOMPOSITION (pure; NO model, NO network, NO Gmail/Sheets/DB, NO draft/send).
 *
 * Given a saved FULL live validation report (one carrying the sanitized Terra base draft), this rebuilds the
 * enriched email from the EXACT saved Terra draft using the CURRENT deterministic templates + one-sentence
 * competitor-insertion rule, reruns the deterministic rubric and ALL hard gates, and reports the new result
 * with a before/after of the competitor section. Unlike the determinism REPLAY (which proves a saved
 * artifact still reproduces its OWN stored hash), recomposition intentionally applies the NEW copy rules, so
 * the composed hash is EXPECTED to change — it is the audit of the copy-flow fix.
 *
 * Integrity is enforced first: a report-hash mismatch, a deterministic-block determinism-hash mismatch, a
 * missing Terra base draft, a baseline that no longer matches the saved base, or a package-hash mismatch
 * fails the recomposition before any result is trusted. It makes ZERO Terra/Sol, network, Gmail, Sheets,
 * draft, send, or production-database calls, and never overwrites the source artifact.
 */

import { runValidationHarness } from '../harness.js';
import { buildReport, hashReport, type ValidationReport } from '../validation-report.js';
import { renderEmail } from '../../../domain/email/email-render.js';
import { hashLiveReport, type LiveValidationReport } from './live-report.js';

export interface RecompositionResult {
  ok: boolean;
  /** Recomputed live report hash equals the stored report hash (source artifact not altered). */
  reportHashOk: boolean;
  /** Recomputed deterministic-block determinism hash equals the stored one (deterministic block intact). */
  determinismHashOk: boolean;
  /** The source report carried the sanitized Terra base draft required for a faithful recomposition. */
  hasTerraBaseDraft: boolean;
  /** The rebuilt baseline (prospect-only) body equals the saved baseline body (same Terra base draft). */
  baseDraftMatchesBaseline: boolean;
  /** The rebuilt package hash equals the source report's stored package hash (no scenario drift). */
  packageHashMatches: boolean;
  /** The rebuilt deterministic result under the CURRENT templates. */
  deterministicResult: 'PASS' | 'REVISE' | 'FAIL' | null;
  /** The new rebuilt deterministic report (current templates). */
  rebuilt: ValidationReport | null;
  sourceReportHash: string;
  sourceComposedHash: string | null;
  recomposedComposedHash: string | null;
  competitorSectionBefore: string | null;
  competitorSectionAfter: string | null;
  baselineTotalBefore: number | null;
  enrichedTotalBefore: number | null;
  baselineTotalAfter: number | null;
  enrichedTotalAfter: number | null;
  reasons: string[];
}

/** Reconstruct the SAVED competitor section from the stored claim ledger (competitor + contrast + consequence). */
function competitorSectionFromLedger(report: LiveValidationReport): string | null {
  const ledger = report.deterministic?.claimLedger;
  if (!ledger) return null;
  const parts = ledger
    .filter((e) => e.claimType === 'COMPETITOR_PATTERN' || e.claimType === 'PROSPECT_CONTRAST' || e.claimType === 'CAUTIOUS_CONSEQUENCE')
    .map((e) => e.text.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * Recompose a saved FULL live report OFFLINE with the current deterministic templates and report the new
 * result. Pure except for the offline fixture harness (deterministic; mock capture only). Makes zero
 * model/network/Gmail/Sheets/DB calls.
 */
export async function recomposeLiveValidation(report: LiveValidationReport): Promise<RecompositionResult> {
  const reasons: string[] = [];
  const base: RecompositionResult = {
    ok: false,
    reportHashOk: false,
    determinismHashOk: false,
    hasTerraBaseDraft: report.terraBaseDraft !== null,
    baseDraftMatchesBaseline: false,
    packageHashMatches: false,
    deterministicResult: null,
    rebuilt: null,
    sourceReportHash: report.reportHash,
    sourceComposedHash: report.deterministic?.composedMessageHash ?? null,
    recomposedComposedHash: null,
    competitorSectionBefore: competitorSectionFromLedger(report),
    competitorSectionAfter: null,
    baselineTotalBefore: report.deterministic?.baseline?.rubric.total ?? null,
    enrichedTotalBefore: report.deterministic?.enriched?.rubric.total ?? null,
    baselineTotalAfter: null,
    enrichedTotalAfter: null,
    reasons,
  };

  // --- Integrity gate 1: the live report hash must match (artifact not altered). ---
  base.reportHashOk = hashLiveReport(report) === report.reportHash;
  if (!base.reportHashOk) reasons.push('report hash mismatch — the saved artifact was altered or is incomplete');

  const det = report.deterministic;
  if (!det) {
    reasons.push('no deterministic artifact in the report (Terra base failed); nothing to recompose');
    return base;
  }

  // --- Integrity gate 2: the deterministic block's own determinism hash must match. ---
  base.determinismHashOk = hashReport(det) === det.determinismHash;
  if (!base.determinismHashOk) reasons.push('deterministic report determinism-hash mismatch — the deterministic block was altered');

  if (!report.terraBaseDraft) {
    reasons.push('the report carries no sanitized Terra base draft; a faithful recomposition requires the exact base');
    return base;
  }

  // --- Rebuild from the EXACT saved Terra base draft with the CURRENT deterministic templates. ---
  const outcome = await runValidationHarness(report.terraBaseDraft);
  if (!outcome.ok) {
    reasons.push(`recomposition harness failed at ${outcome.failureStage}: ${outcome.reason}`);
    return base;
  }
  const rebuilt = buildReport(outcome);
  base.rebuilt = rebuilt;
  base.deterministicResult = rebuilt.result;
  base.recomposedComposedHash = rebuilt.composedMessageHash;
  base.competitorSectionAfter = outcome.enriched.sections.find((s) => s.kind === 'COMPETITOR_PATTERN')?.text ?? null;
  base.baselineTotalAfter = rebuilt.baseline?.rubric.total ?? null;
  base.enrichedTotalAfter = rebuilt.enriched?.rubric.total ?? null;

  // --- Integrity gate 3: the rebuilt baseline must match the saved baseline (same Terra base draft). ---
  const rebuiltBaselineBody = renderEmail(report.terraBaseDraft, outcome.emailInputs).body;
  base.baseDraftMatchesBaseline = rebuiltBaselineBody === (det.baseline?.body ?? null);
  if (!base.baseDraftMatchesBaseline) reasons.push('rebuilt baseline body differs from the saved baseline — the saved base draft does not match the saved baseline artifact');

  // --- Integrity gate 4: package hash stability (no scenario drift). ---
  base.packageHashMatches = outcome.enrichmentPackage.packageHash === (det.pipeline.packageHash ?? null);
  if (!base.packageHashMatches) reasons.push('rebuilt package hash differs from the stored package hash (scenario drift)');

  const integrityOk = base.reportHashOk && base.determinismHashOk && base.baseDraftMatchesBaseline && base.packageHashMatches;
  base.ok = integrityOk && rebuilt.hardGates!.allPassed && rebuilt.result === 'PASS';
  if (base.ok) {
    reasons.push('recomposition passed: integrity verified, one-sentence competitor section, all hard gates passed, deterministic result PASS');
  } else if (integrityOk && !rebuilt.hardGates!.allPassed) {
    reasons.push(`recomposition hard gate(s) failed: ${rebuilt.hardGates!.failedIds.join(', ')}`);
  } else if (integrityOk && rebuilt.result !== 'PASS') {
    reasons.push(`recomposition deterministic result is ${rebuilt.result} (expected PASS)`);
  }
  return base;
}

/** Human-readable recomposition summary for the CLI (bounded; no secrets). */
export function renderRecompositionResult(result: RecompositionResult): string {
  const lines: string[] = [];
  lines.push('# Phase 7A4B2 — Offline Competitor-Email Recomposition');
  lines.push(`result: ${result.ok ? 'PASS' : 'NOT PASS'}   deterministic: ${result.deterministicResult ?? '(none)'}`);
  lines.push(`  report hash ok:            ${String(result.reportHashOk)}`);
  lines.push(`  determinism hash ok:       ${String(result.determinismHashOk)}`);
  lines.push(`  Terra base draft present:  ${String(result.hasTerraBaseDraft)}`);
  lines.push(`  baseline matches base:     ${String(result.baseDraftMatchesBaseline)}`);
  lines.push(`  package hash matches:      ${String(result.packageHashMatches)}`);
  lines.push('\n## Competitor section — before → after');
  lines.push(`  before: ${result.competitorSectionBefore ?? '(none)'}`);
  lines.push(`  after:  ${result.competitorSectionAfter ?? '(none)'}`);
  lines.push('\n## Scores (baseline → enriched)');
  lines.push(`  before: ${String(result.baselineTotalBefore)} → ${String(result.enrichedTotalBefore)}`);
  lines.push(`  after:  ${String(result.baselineTotalAfter)} → ${String(result.enrichedTotalAfter)}`);
  if (result.sourceComposedHash) lines.push(`\n  source composed hash:     ${result.sourceComposedHash.slice(0, 16)}`);
  if (result.recomposedComposedHash) lines.push(`  recomposed composed hash: ${result.recomposedComposedHash.slice(0, 16)}`);
  lines.push('');
  for (const r of result.reasons) lines.push(`  • ${r}`);
  lines.push('\nNo Terra/Sol call, network request, Gmail, Sheets, draft, send, or production database write occurred. The source artifact was not modified.');
  return lines.join('\n');
}
