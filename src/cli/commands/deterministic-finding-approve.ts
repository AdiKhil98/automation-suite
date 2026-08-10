import { randomUUID } from 'node:crypto';
import { DETERMINISTIC_FINDING_PROVENANCE } from '../../domain/deterministic-finding/constants.js';
import {
  type ApprovedDeterministicFinding,
  type DeterministicFindingApprovalInput,
} from '../../domain/deterministic-finding/types.js';
import { validateDeterministicFinding } from '../../domain/deterministic-finding/validation.js';
import { DeterministicFindingRepository } from '../../persistence/repositories/deterministic-finding.repo.js';
import { DrizzleDeterministicFindingUnitOfWork } from '../../persistence/deterministic-finding-unit-of-work.js';
import { AppError } from '../../utils/errors.js';
import { type CliContext } from '../context.js';

/** The only lead status a deterministic finding may be approved from (fail-closed otherwise). */
const APPROVABLE_FROM = 'NEEDS_MANUAL_REVIEW';
/** The single supported target status this command transitions the lead into. */
const APPROVE_TARGET = 'OUTREACH_READY_DETERMINISTIC';

export interface DeterministicFindingApproveOptions {
  lead?: string;
  category?: string;
  evidence?: string;
  by?: string;
  confirm?: boolean;
}

function parseEvidenceIds(raw: string): string[] {
  return [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0))];
}

/**
 * Approve exactly one deterministic, evidence-backed, template-constrained outreach finding for a
 * lead whose AI audit produced no outreach-safe finding. Single-lead only (no bulk fallback).
 *
 * Behaviour:
 *  - Reads the lead's latest completed capture + the cited evidence + all run evidence (SELECT only).
 *  - Runs the deterministic validator. On ANY violation it prints them and exits 1 — nothing is written.
 *  - Without `--confirm` it prints the exact finding that WOULD be created and stops (dry preview).
 *  - With `--confirm` it persists the finding + evidence links, transitions
 *    NEEDS_MANUAL_REVIEW -> OUTREACH_READY_DETERMINISTIC, and records an operator NOTE.
 *
 * It never fabricates an AI audit run, never touches audit_runs/audit_findings (the prior
 * VALIDATION_FAILED audit is preserved), never marks anything AI/reviewer-approved, and makes no
 * LLM / network / Gmail / Sheets / send call. Does NOT generate an email.
 */
export async function deterministicFindingApproveCommand(
  ctx: CliContext,
  opts: DeterministicFindingApproveOptions,
): Promise<void> {
  const leadId = opts.lead?.trim();
  const category = opts.category?.trim();
  const operator = opts.by?.trim();
  const evidenceRaw = opts.evidence?.trim();
  if (!leadId) throw new AppError('LEAD_REQUIRED', '--lead <id> is required (exactly one lead; no bulk fallback).');
  if (!category) throw new AppError('CATEGORY_REQUIRED', '--category <CATEGORY> is required.');
  if (!evidenceRaw) throw new AppError('EVIDENCE_REQUIRED', '--evidence <id,id,...> is required.');
  if (!operator) throw new AppError('OPERATOR_REQUIRED', '--by <operator> is required.');

  const requestedEvidenceIds = parseEvidenceIds(evidenceRaw);

  const lead = await ctx.leads.getById(leadId);
  if (!lead) throw new AppError('LEAD_NOT_FOUND', `Lead ${leadId} not found; refusing to approve.`);
  if (lead.status !== APPROVABLE_FROM) {
    throw new AppError(
      'LEAD_NOT_APPROVABLE',
      `Lead is ${lead.status}; a deterministic finding can only be approved from ${APPROVABLE_FROM}.`,
    );
  }

  // --- read-only approval context ---
  const readRepo = new DeterministicFindingRepository(ctx.db);
  const captureRun = await readRepo.latestCaptureRun(leadId);
  const citedEvidence = await readRepo.loadCitedEvidence(requestedEvidenceIds);
  const runEvidence = captureRun ? await readRepo.loadRunEvidence(captureRun.id) : [];
  const activeCategories = await readRepo.listActiveCategories(leadId);

  const input: DeterministicFindingApprovalInput = {
    leadId,
    category,
    operator,
    now: new Date(),
    findingId: randomUUID(),
    requestedEvidenceIds,
    captureRun,
    citedEvidence,
    runEvidence,
    activeCategories,
  };

  const result = validateDeterministicFinding(input);
  if (!result.ok) {
    console.error(`Deterministic finding REFUSED (fail-closed). Violations:\n  - ${result.violations.join('\n  - ')}`);
    console.error('\nNo finding written. No state change. No side effects.');
    process.exitCode = 1;
    return;
  }

  printFinding(result.finding);

  if (!opts.confirm) {
    console.log('\n  Dry preview only. Re-run with --confirm to persist the finding + transition the lead.');
    console.log('  No finding written. No state change. No LLM/network/Gmail/Sheet/send.');
    return;
  }

  // --- persist atomically: finding + evidence links + state transition + operator NOTE ---
  const uow = new DrizzleDeterministicFindingUnitOfWork(ctx.db);
  await uow.transaction(async (repos) => {
    await repos.deterministic.insertApproved(result.finding);
    await repos.leadService.transition(leadId, APPROVE_TARGET);
    await repos.events.record({
      leadId,
      runId: null,
      type: 'NOTE',
      fromStatus: APPROVABLE_FROM,
      toStatus: APPROVE_TARGET,
      message: `deterministic finding approved: ${result.finding.category} (by ${operator})`,
      data: {
        provenance: DETERMINISTIC_FINDING_PROVENANCE,
        deterministicFindingId: result.finding.id,
        category: result.finding.category,
        evidenceIds: result.finding.evidenceIds,
        evidenceHash: result.finding.evidenceHash,
        captureRunId: result.finding.captureRunId,
        rulesVersion: result.finding.rulesVersion,
        templateVersion: result.finding.templateVersion,
        operator,
      },
    });
  });

  console.log(`\n  Persisted deterministic finding ${result.finding.id} (ACTIVE, safeForOutreach=true).`);
  console.log(`  Lead ${leadId}: ${APPROVABLE_FROM} -> ${APPROVE_TARGET}.`);
  console.log('  Prior AI audit history untouched. No LLM/network/Gmail/Sheet/send. No email generated.');
}

function printFinding(f: ApprovedDeterministicFinding): void {
  console.log(`\n=== Deterministic finding (lead ${f.leadId}) ===`);
  console.log(`  provenance:        ${f.provenance}`);
  console.log(`  category:          ${f.category}`);
  console.log(`  finding ref:       ${f.findingRef}`);
  console.log(`  safeForOutreach:   ${String(f.safeForOutreach)}`);
  console.log(`  capture run:       ${f.captureRunId}`);
  console.log(`  approved by:       ${f.approvedBy}`);
  console.log(`  template version:  ${f.templateVersion}`);
  console.log(`  rules version:     ${f.rulesVersion}`);
  console.log(`  evidence hash:     ${f.evidenceHash}`);
  console.log(`  evidence ids:      ${f.evidenceIds.join(', ')}`);
  console.log(`\n  observation:     ${f.observation}`);
  console.log(`  recommendation:  ${f.recommendation}`);
}
