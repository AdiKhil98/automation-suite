/**
 * Phase 7A4B1 — offline determinism REPLAY (pure; NO model, NO network, NO Gmail/Sheets/DB, NO draft/send).
 *
 * Given a saved live validation report, this re-derives the deterministic package, enrichment, claim spans,
 * composed-message hash, and hard gates OFFLINE and reports whether the composed hash + claim spans are
 * reproducible — WITHOUT spending another live Terra/Sol call. Two modes:
 *
 *   FULL     — the report carries the sanitized Terra base draft (`terraBaseDraft`). The complete Phase
 *              7A1–7A3B harness is re-run from that exact draft and the recomputed determinism hash,
 *              composed-message hash, claim spans, and hard-gate outcome are compared to the stored report.
 *   REDUCED  — a legacy report without `terraBaseDraft`. The default fixture harness supplies the
 *              deterministic package provenance (package id/version/hash — independent of the base draft),
 *              and the composed-message hash is recomputed canonically from the stored rendered subject/body
 *              + claim ledger, then compared to the stored hash. Claim spans are re-derived from the stored
 *              body + ledger and re-validated.
 *
 * Integrity is enforced first: a report-hash mismatch or a deterministic-report determinism-hash mismatch
 * (i.e. an altered/incomplete artifact) fails the replay before any reproducibility claim is made.
 */

import { runValidationHarness } from '../harness.js';
import { buildReport, hashReport } from '../validation-report.js';
import { hashLiveReport, type LiveValidationReport } from './live-report.js';
import {
  computeComposedMessageHash,
  type ComposedHashLedgerEntry,
} from '../../../domain/email/competitor-email-composer.js';
import {
  claimSpansResolved,
  COMPETITOR_ENRICHMENT_RULES_VERSION,
  deriveClaimSpans,
  type ClaimLedgerEntry,
  type ClaimType,
} from '../../../domain/email/competitor-enrichment.js';

export interface ReplayResult {
  ok: boolean;
  mode: 'FULL' | 'REDUCED' | 'NO_ARTIFACT';
  /** Recomputed live report hash equals the stored report hash (artifact not altered). */
  reportHashOk: boolean;
  /** Recomputed deterministic-report determinism hash equals the stored one (deterministic block intact). */
  determinismHashOk: boolean;
  /** The recomputed composed-message hash equals the stored composed-message hash. */
  composedHashReproducible: boolean;
  /** Every re-derived claim span resolves to an exact bounded body substring (and, in FULL mode, matches). */
  claimSpansReproducible: boolean;
  storedComposedHash: string | null;
  recomputedComposedHash: string | null;
  reasons: string[];
}

/** Map a stored claim-ledger row (report JSON) onto the composer's hash-ledger shape. */
function toHashLedger(rows: ValidationReport['claimLedger']): ComposedHashLedgerEntry[] {
  return rows.map((e) => ({
    claimType: e.claimType,
    text: e.text,
    prospectEvidenceIds: e.prospectEvidenceIds,
    patternId: e.patternId,
    contrastId: e.contrastId,
    competitorEvidenceIds: e.competitorEvidenceIds,
  }));
}

/** Map a stored claim-ledger row onto the ledger-entry shape `deriveClaimSpans` consumes (spans skip CTA). */
function toSpanLedger(rows: ValidationReport['claimLedger']): ClaimLedgerEntry[] {
  return rows.map((e) => ({
    claimType: e.claimType as ClaimType,
    text: e.text,
    prospectEvidenceIds: e.prospectEvidenceIds,
    patternId: e.patternId,
    contrastId: e.contrastId,
    competitorEvidenceIds: e.competitorEvidenceIds,
    externallySafe: true,
  }));
}

type ValidationReport = NonNullable<LiveValidationReport['deterministic']>;

/**
 * Replay a saved live validation report OFFLINE and report reproducibility. Pure except for the offline
 * fixture harness (deterministic; mock capture only). Makes zero model/network/Gmail/Sheets/DB calls.
 */
export async function replayLiveValidation(report: LiveValidationReport): Promise<ReplayResult> {
  const reasons: string[] = [];

  // --- Integrity gate 1: the live report hash must match (artifact not altered). ---
  const reportHashOk = hashLiveReport(report) === report.reportHash;
  if (!reportHashOk) reasons.push('report hash mismatch — the saved artifact was altered or is incomplete');

  const det = report.deterministic;
  if (!det) {
    // Terra failed before producing a valid base; there is no enriched artifact to replay.
    reasons.push('no deterministic artifact in the report (Terra base failed); nothing to replay');
    return {
      ok: false, mode: 'NO_ARTIFACT', reportHashOk, determinismHashOk: false,
      composedHashReproducible: false, claimSpansReproducible: false,
      storedComposedHash: null, recomputedComposedHash: null, reasons,
    };
  }

  // --- Integrity gate 2: the deterministic report's own determinism hash must match. ---
  const determinismHashOk = hashReport(det) === det.determinismHash;
  if (!determinismHashOk) reasons.push('deterministic report determinism-hash mismatch — the deterministic block was altered');

  if (!det.enriched || det.composedMessageHash === null) {
    reasons.push('the report carries no enriched email / composed hash to reproduce');
    return {
      ok: false, mode: report.terraBaseDraft ? 'FULL' : 'REDUCED', reportHashOk, determinismHashOk,
      composedHashReproducible: false, claimSpansReproducible: false,
      storedComposedHash: det.composedMessageHash, recomputedComposedHash: null, reasons,
    };
  }

  const storedComposedHash = det.composedMessageHash;

  // --- Re-derive claim spans from the STORED rendered body + ledger (both modes). ---
  const spans = deriveClaimSpans(det.enriched.body, toSpanLedger(det.claimLedger));
  const spansResolve = claimSpansResolved(spans);
  if (!spansResolve) reasons.push('one or more claim spans do not resolve to a bounded body substring');

  if (report.terraBaseDraft) {
    // --- FULL replay: re-run the entire deterministic pipeline from the exact stored base draft. ---
    const outcome = await runValidationHarness(report.terraBaseDraft);
    if (!outcome.ok) {
      reasons.push(`FULL replay harness failed at ${outcome.failureStage}: ${outcome.reason}`);
      return {
        ok: false, mode: 'FULL', reportHashOk, determinismHashOk,
        composedHashReproducible: false, claimSpansReproducible: false,
        storedComposedHash, recomputedComposedHash: null, reasons,
      };
    }
    const rebuilt = buildReport(outcome);
    const recomputedComposedHash = rebuilt.composedMessageHash;
    const composedHashReproducible = recomputedComposedHash === storedComposedHash;
    if (!composedHashReproducible) reasons.push('FULL replay: recomputed composed-message hash differs from the stored hash');

    const bodyMatches = rebuilt.enriched?.body === det.enriched.body;
    const subjectMatches = rebuilt.enriched?.subject === det.enriched.subject;
    if (!bodyMatches) reasons.push('FULL replay: recomputed enriched body differs from the stored body');
    if (!subjectMatches) reasons.push('FULL replay: recomputed enriched subject differs from the stored subject');
    const determinismReproduced = rebuilt.determinismHash === det.determinismHash;
    if (!determinismReproduced) reasons.push('FULL replay: recomputed deterministic determinism-hash differs from the stored hash');

    const claimSpansReproducible = spansResolve && bodyMatches;
    const ok = reportHashOk && determinismHashOk && composedHashReproducible && claimSpansReproducible && determinismReproduced;
    if (ok) reasons.push('FULL replay reproduced the composed-message hash, claim spans, and determinism hash with zero live calls');
    return { ok, mode: 'FULL', reportHashOk, determinismHashOk, composedHashReproducible, claimSpansReproducible, storedComposedHash, recomputedComposedHash, reasons };
  }

  // --- REDUCED replay (legacy artifact): fixture harness supplies deterministic package provenance. ---
  const provenance = await runValidationHarness();
  if (!provenance.ok) {
    reasons.push(`REDUCED replay provenance harness failed at ${provenance.failureStage}: ${provenance.reason}`);
    return {
      ok: false, mode: 'REDUCED', reportHashOk, determinismHashOk,
      composedHashReproducible: false, claimSpansReproducible: false,
      storedComposedHash, recomputedComposedHash: null, reasons,
    };
  }
  const pkgHashMatches = provenance.enrichmentPackage.packageHash === det.pipeline.packageHash;
  if (!pkgHashMatches) reasons.push('REDUCED replay: fixture package hash differs from the stored package hash (scenario drift)');

  const recomputedComposedHash = computeComposedMessageHash({
    schemaVersion: det.enriched.schemaVersion,
    mode: det.enriched.evidenceMode,
    subject: det.enriched.subject,
    body: det.enriched.body,
    packageId: provenance.enrichmentPackage.packageId,
    packageVersion: provenance.enrichmentPackage.version,
    packageHash: det.pipeline.packageHash ?? provenance.enrichmentPackage.packageHash,
    selectedPatternId: det.selection.patternId ?? provenance.plan.selection.pattern.patternId,
    selectedContrastId: det.selection.contrastId,
    rulesVersion: COMPETITOR_ENRICHMENT_RULES_VERSION,
    ledger: toHashLedger(det.claimLedger),
  });
  const composedHashReproducible = recomputedComposedHash === storedComposedHash;
  if (!composedHashReproducible) reasons.push('REDUCED replay: recomputed composed-message hash differs from the stored hash');

  const claimSpansReproducible = spansResolve;
  const ok = reportHashOk && determinismHashOk && pkgHashMatches && composedHashReproducible && claimSpansReproducible;
  if (ok) reasons.push('REDUCED replay reproduced the composed-message hash + claim spans from the stored artifact with zero live calls');
  return { ok, mode: 'REDUCED', reportHashOk, determinismHashOk, composedHashReproducible, claimSpansReproducible, storedComposedHash, recomputedComposedHash, reasons };
}

/** Human-readable replay summary for the CLI (bounded; no secrets). */
export function renderReplayResult(result: ReplayResult): string {
  const lines: string[] = [];
  lines.push('# Phase 7A4B1 — Offline Determinism Replay');
  lines.push(`mode: ${result.mode}   result: ${result.ok ? 'REPRODUCIBLE' : 'NOT REPRODUCIBLE'}`);
  lines.push(`  report hash ok:            ${String(result.reportHashOk)}`);
  lines.push(`  determinism hash ok:       ${String(result.determinismHashOk)}`);
  lines.push(`  composed hash reproducible:${String(result.composedHashReproducible)}`);
  lines.push(`  claim spans reproducible:  ${String(result.claimSpansReproducible)}`);
  if (result.storedComposedHash) lines.push(`  stored composed hash:      ${result.storedComposedHash.slice(0, 16)}`);
  if (result.recomputedComposedHash) lines.push(`  recomputed composed hash:  ${result.recomputedComposedHash.slice(0, 16)}`);
  for (const r of result.reasons) lines.push(`  • ${r}`);
  lines.push('\nNo Terra/Sol call, network request, Gmail, Sheets, draft, send, or production database write occurred.');
  return lines.join('\n');
}
