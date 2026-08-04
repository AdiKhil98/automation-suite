/**
 * Phase 7A4B — live validation report. Wraps the reused 7A4A deterministic `ValidationReport` with the
 * Terra/Sol call metadata and the ADVISORY Sol critique, and derives the combined operator status. The only
 * allowed statuses are READY_FOR_OPERATOR_REVIEW, REQUIRES_REVISION, VALIDATION_FAILED — never a production
 * go-live approval. Deterministic safety is authoritative: Sol can only DOWNGRADE, never rescue a FAIL.
 */

import { createHash } from 'node:crypto';
import { renderReportText, type ValidationReport, type ValidationResultKind } from '../validation-report.js';
import { COMPETITOR_EMAIL_VALIDATION_RULES_VERSION } from '../constants.js';
import { type SolCritiqueParsed } from '../../../domain/email/sol-critique-schema.js';
import { type EmailWriterParsed } from '../../../domain/email/email-schema.js';
import { type CombinedOperatorStatus, type LiveModelCall } from './live-types.js';

export interface LiveSolResult {
  ran: boolean;
  malformed: boolean;
  reason: string | null;
  critique: SolCritiqueParsed | null;
  materiallyWorse: boolean | null;
  call: LiveModelCall | null;
}

export interface LiveTerraResult {
  ok: boolean;
  reason: string | null;
  violations: string[];
  call: LiveModelCall | null;
}

export interface LiveValidationReport {
  rulesVersion: string;
  phase: '7A4B';
  scenarioLabel: string;
  fixtureId: string;
  mode: 'MOCK' | 'LIVE';
  generatedAt: string;
  routing: { terraRole: 'BASE_GENERATION'; terraModel: string; solRole: 'ADVISORY_CRITIQUE'; solModel: string };
  budget: { maxLiveCalls: number; terraCalls: number; solCalls: number; totalCalls: number };
  terra: LiveTerraResult;
  deterministic: ValidationReport | null;
  sol: LiveSolResult;
  /**
   * The sanitized prospect-only base draft Terra produced (null when Terra failed before a valid draft).
   * Persisted so the offline replay can re-run the FULL deterministic pipeline from the exact base draft
   * WITHOUT another live call. It is fictional-prospect copy only — no competitor data, provider metadata,
   * or secrets — and is intentionally EXCLUDED from `reportHash` (its rendered subject/body already bind
   * transitively via `deterministic.determinismHash`), so adding it never changes an existing report hash.
   */
  terraBaseDraft: EmailWriterParsed | null;
  /**
   * Provenance link for a Sol-only re-review report (Phase 7A4B2): the `reportHash` of the source live
   * report whose exact stored Terra base draft was reused. Null for an original live/mock run. Like
   * `terraBaseDraft`, it is intentionally EXCLUDED from `reportHash` (pure provenance metadata), so adding
   * it never changes an existing report hash.
   */
  sourceReportHash: string | null;
  combinedStatus: CombinedOperatorStatus;
  combinedReasons: string[];
  reportHash: string;
}

export interface CombinedDecisionInput {
  terraOk: boolean;
  /** null when Terra failed (no enrichment, no deterministic result). */
  deterministicResult: ValidationResultKind | null;
  sol: {
    ran: boolean;
    malformed: boolean;
    unsupportedClaimSuspected: boolean | null;
    criticalIssueCount: number | null;
    materiallyWorse: boolean | null;
    advisoryVerdict: 'PASS' | 'REVISE' | 'FAIL' | null;
  } | null;
}

/**
 * Pure combined-status decision. SAFETY OVERRIDES ADVICE: a Terra failure or a deterministic FAIL is always
 * VALIDATION_FAILED regardless of Sol. Otherwise the enriched email reaches READY_FOR_OPERATOR_REVIEW only
 * when the deterministic result is PASS and Sol is fully clean; any deterministic REVISE or any Sol concern
 * downgrades to REQUIRES_REVISION. Sol can never upgrade.
 */
export function decideCombinedStatus(input: CombinedDecisionInput): { status: CombinedOperatorStatus; reasons: string[] } {
  if (!input.terraOk || input.deterministicResult === null) {
    return { status: 'VALIDATION_FAILED', reasons: ['Terra base generation failed deterministic validation; enrichment and Sol were not run'] };
  }
  if (input.deterministicResult === 'FAIL') {
    return { status: 'VALIDATION_FAILED', reasons: ['deterministic hard safety gate(s) failed; Sol cannot override safety'] };
  }

  const downgrades: string[] = [];
  if (input.deterministicResult === 'REVISE') downgrades.push('deterministic quality thresholds unmet (REVISE)');

  if (input.sol === null || !input.sol.ran) {
    downgrades.push('Sol advisory critique did not run');
  } else if (input.sol.malformed) {
    downgrades.push('Sol response malformed (advisory failure)');
  } else {
    if (input.sol.unsupportedClaimSuspected) downgrades.push('Sol suspects an unsupported claim');
    if ((input.sol.criticalIssueCount ?? 0) > 0) downgrades.push('Sol reported critical issue(s)');
    if (input.sol.materiallyWorse) downgrades.push('Sol rates the enriched email materially worse than the baseline');
    if (input.sol.advisoryVerdict && input.sol.advisoryVerdict !== 'PASS') downgrades.push(`Sol advisory verdict is ${input.sol.advisoryVerdict}`);
  }

  if (downgrades.length > 0) return { status: 'REQUIRES_REVISION', reasons: downgrades };
  return { status: 'READY_FOR_OPERATOR_REVIEW', reasons: ['deterministic result PASS and Sol advisory critique clean (advisory only; not a production go-live approval)'] };
}

export interface BuildLiveReportArgs {
  fixtureId: string;
  scenarioLabel: string;
  mode: 'MOCK' | 'LIVE';
  now: Date;
  terraModel: string;
  solModel: string;
  maxLiveCalls: number;
  terra: LiveTerraResult;
  deterministic: ValidationReport | null;
  sol: LiveSolResult;
  terraBaseDraft?: EmailWriterParsed | null;
  sourceReportHash?: string | null;
}

export function buildLiveReport(args: BuildLiveReportArgs): LiveValidationReport {
  const deterministicResult: ValidationResultKind | null = args.deterministic ? args.deterministic.result : null;
  const critique = args.sol.critique;
  const { status, reasons } = decideCombinedStatus({
    terraOk: args.terra.ok,
    deterministicResult,
    sol: args.sol.ran
      ? {
        ran: true,
        malformed: args.sol.malformed,
        unsupportedClaimSuspected: critique?.unsupportedClaimSuspected ?? null,
        criticalIssueCount: critique?.criticalIssues.length ?? null,
        materiallyWorse: args.sol.materiallyWorse,
        advisoryVerdict: critique?.advisoryVerdict ?? null,
      }
      : null,
  });

  const terraCalls = args.terra.call ? 1 : 0;
  const solCalls = args.sol.call ? 1 : 0;

  const report: LiveValidationReport = {
    rulesVersion: COMPETITOR_EMAIL_VALIDATION_RULES_VERSION,
    phase: '7A4B',
    scenarioLabel: args.scenarioLabel,
    fixtureId: args.fixtureId,
    mode: args.mode,
    generatedAt: args.now.toISOString(),
    routing: { terraRole: 'BASE_GENERATION', terraModel: args.terraModel, solRole: 'ADVISORY_CRITIQUE', solModel: args.solModel },
    budget: { maxLiveCalls: args.maxLiveCalls, terraCalls, solCalls, totalCalls: terraCalls + solCalls },
    terra: args.terra,
    deterministic: args.deterministic,
    sol: args.sol,
    terraBaseDraft: args.terraBaseDraft ?? null,
    sourceReportHash: args.sourceReportHash ?? null,
    combinedStatus: status,
    combinedReasons: reasons,
    reportHash: '',
  };
  report.reportHash = hashLiveReport(report);
  return report;
}

/** Canonical stable-key JSON (arrays kept in order). */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

/**
 * Stable hash over the run's MEANINGFUL content, excluding volatile provider/runtime fields (timestamps,
 * latency, request/response ids, token counts, cost) so two mock runs are byte-identical.
 */
export function hashLiveReport(report: LiveValidationReport): string {
  const stable = {
    rulesVersion: report.rulesVersion,
    scenarioLabel: report.scenarioLabel,
    fixtureId: report.fixtureId,
    mode: report.mode,
    routing: report.routing,
    budget: { maxLiveCalls: report.budget.maxLiveCalls, terraCalls: report.budget.terraCalls, solCalls: report.budget.solCalls, totalCalls: report.budget.totalCalls },
    terraOk: report.terra.ok,
    terraReason: report.terra.reason,
    terraViolations: report.terra.violations,
    deterministicHash: report.deterministic?.determinismHash ?? null,
    deterministicResult: report.deterministic?.result ?? null,
    solRan: report.sol.ran,
    solMalformed: report.sol.malformed,
    solReason: report.sol.reason,
    solCritique: report.sol.critique,
    solMateriallyWorse: report.sol.materiallyWorse,
    combinedStatus: report.combinedStatus,
    combinedReasons: report.combinedReasons,
  };
  return createHash('sha256').update(canonical(stable)).digest('hex');
}

export function renderLiveReportText(report: LiveValidationReport): string {
  const lines: string[] = [];
  lines.push(`# Phase 7A4B — Guarded Live-Model Email Validation (${report.mode})`);
  lines.push(`scenario: ${report.scenarioLabel}   fixture: ${report.fixtureId}`);
  lines.push(`combined operator status: ${report.combinedStatus}`);
  for (const r of report.combinedReasons) lines.push(`  • ${r}`);
  lines.push('\n## Routing (approved Phase 7A4B flags; production email models unchanged)');
  lines.push(`  Terra (${report.routing.terraModel}) — ${report.routing.terraRole}`);
  lines.push(`  Sol   (${report.routing.solModel}) — ${report.routing.solRole} (advisory only)`);
  lines.push('\n## Live-call budget');
  lines.push(`  max ${String(report.budget.maxLiveCalls)}   Terra calls: ${String(report.budget.terraCalls)}   Sol calls: ${String(report.budget.solCalls)}   total: ${String(report.budget.totalCalls)}`);
  lines.push('\n## Terra base generation');
  lines.push(`  status: ${report.terra.ok ? 'OK' : `FAILED (${report.terra.reason ?? 'unknown'})`}`);
  if (report.terra.violations.length > 0) for (const v of report.terra.violations) lines.push(`    - ${v}`);
  if (report.terra.call) lines.push(`  model: ${report.terra.call.requestedModel} -> ${report.terra.call.resolvedModel ?? '(n/a)'}   provider: ${report.terra.call.provider}   status: ${report.terra.call.status}   in/out tok: ${String(report.terra.call.inputTokens)}/${String(report.terra.call.outputTokens)}   cost: ${report.terra.call.estimatedCostUsd === null ? 'n/a' : `$${report.terra.call.estimatedCostUsd.toFixed(6)}`}`);

  if (report.deterministic) {
    lines.push('\n## Deterministic validation (authoritative)\n');
    lines.push(renderReportText(report.deterministic));
  } else {
    lines.push('\n## Deterministic validation\n  (not run — Terra base did not pass prospect-only validation)');
  }

  lines.push('\n## Sol advisory critique (advisory only; cannot override safety)');
  if (!report.sol.ran) {
    lines.push('  Sol did not run.');
  } else if (report.sol.malformed || report.sol.critique === null) {
    lines.push(`  Sol response unusable: ${report.sol.reason ?? 'malformed'} (treated as advisory failure).`);
  } else {
    const c = report.sol.critique;
    lines.push(`  preferred: ${c.preferredVersion}   quality: baseline ${String(c.baselineQualityScore)} vs enriched ${String(c.enrichedQualityScore)}   verdict: ${c.advisoryVerdict}`);
    lines.push(`  materially worse than baseline: ${String(report.sol.materiallyWorse)}   mechanical wording: ${String(c.mechanicalWordingDetected)}   unsupported claim suspected: ${String(c.unsupportedClaimSuspected)}`);
    lines.push(`  naturalness: ${c.naturalnessAssessment}`);
    lines.push(`  credibility: ${c.credibilityAssessment}`);
    lines.push(`  flow: ${c.flowAssessment}`);
    if (c.criticalIssues.length > 0) { lines.push('  critical issues:'); for (const i of c.criticalIssues) lines.push(`    - ${i}`); }
    if (c.improvementSuggestions.length > 0) { lines.push('  suggestions:'); for (const i of c.improvementSuggestions) lines.push(`    - ${i}`); }
  }
  lines.push(`\nlive report hash: ${report.reportHash.slice(0, 16)}`);
  lines.push('advisory only — this run does NOT constitute a production go-live approval (Phase 7A4C decides).');
  return lines.join('\n');
}

/** Pure retention selection: names to delete because they exceed keepLatest OR are older than retentionDays. */
export function selectReportsToPrune(
  files: Array<{ name: string; mtimeMs: number }>,
  retentionDays: number,
  keepLatest: number,
  now: Date,
): string[] {
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const sorted = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const toDelete = new Set<string>();
  sorted.forEach((f, i) => {
    if (i >= keepLatest) toDelete.add(f.name);
    if (f.mtimeMs < cutoff) toDelete.add(f.name);
  });
  return [...toDelete];
}
