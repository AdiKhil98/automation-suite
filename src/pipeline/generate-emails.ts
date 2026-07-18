import { type Logger } from 'pino';
import { type EmailOutcome, type EmailWriteInput, type EmailWriterService } from '../domain/email/email-writer-service.js';

export interface EmailItem {
  input: EmailWriteInput;
}
export interface EmailDeps {
  service: EmailWriterService;
  logger: Logger;
}
export interface EmailRunOptions {
  runId: string;
}

const OUTCOMES: EmailOutcome[] = [
  'APPROVED_READY', 'APPROVED_WAITING_URL', 'REVIEW_REJECTED', 'VALIDATION_FAILED',
  'SCHEMA_INVALID', 'BUDGET_BLOCKED', 'MODEL_REFUSAL', 'RATE_LIMITED', 'TRANSIENT_PROVIDER_ERROR',
];

export type EmailSummary = Record<EmailOutcome, number> & { failed: number; totalCostUsd: number };

function empty(): EmailSummary {
  const s = { failed: 0, totalCostUsd: 0 } as EmailSummary;
  for (const o of OUTCOMES) s[o] = 0;
  return s;
}

/** Write one email per lead. Each lead is independent and atomic. */
export async function generateEmails(deps: EmailDeps, items: EmailItem[], opts: EmailRunOptions): Promise<EmailSummary> {
  const summary = empty();
  for (const item of items) {
    try {
      const r = await deps.service.write(item.input, opts.runId);
      summary[r.outcome] += 1;
      summary.totalCostUsd += r.costUsd;
    } catch (err) {
      summary.failed += 1;
      deps.logger.error({ leadId: item.input.leadId, err: err instanceof Error ? err.message : String(err) }, 'email generation failed (internal)');
    }
  }
  return summary;
}
