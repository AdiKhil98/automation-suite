import { type Logger } from 'pino';
import { AUDIT_OUTCOMES, type AuditOutcome } from '../domain/audit/audit-types.js';
import { type AuditInput, type AuditService } from '../domain/audit/audit-service.js';

export interface AuditItem {
  input: AuditInput;
}

export interface AuditDeps {
  service: AuditService;
  logger: Logger;
}

export interface AuditRunOptions {
  runId: string;
  /** Hard cap on paid model calls across the whole run (kill switch granularity). */
  maxCallsPerRun: number;
  maxCostUsdPerRun: number;
}

export type AuditSummary = Record<AuditOutcome, number> & {
  failed: number;
  totalCalls: number;
  skippedBudget: number;
};

function emptySummary(): AuditSummary {
  const s = { failed: 0, totalCalls: 0, skippedBudget: 0 } as AuditSummary;
  for (const o of AUDIT_OUTCOMES) s[o] = 0;
  return s;
}

/**
 * Audit a batch of leads. Each lead is independent and atomic; a run-level call
 * budget stops the batch early rather than exceeding the configured spend. Leads
 * skipped by the run budget are untouched (still READY_FOR_AUDIT).
 */
export async function auditWebsites(deps: AuditDeps, items: AuditItem[], opts: AuditRunOptions): Promise<AuditSummary> {
  const summary = emptySummary();
  for (const item of items) {
    if (summary.totalCalls >= opts.maxCallsPerRun) {
      summary.skippedBudget += 1;
      continue;
    }
    try {
      const r = await deps.service.audit(item.input, opts.runId);
      summary[r.outcome] += 1;
      summary.totalCalls += r.callsMade;
    } catch (err) {
      summary.failed += 1;
      deps.logger.error(
        { leadId: item.input.leadId, err: err instanceof Error ? err.message : String(err) },
        'audit failed (internal)',
      );
    }
  }
  return summary;
}
