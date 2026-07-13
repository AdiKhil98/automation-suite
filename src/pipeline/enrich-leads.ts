import { type Logger } from 'pino';
import { EnrichmentService, type EnrichmentResult } from '../domain/enrichment/enrichment-service.js';
import { type EnrichmentOutcome } from '../domain/enrichment/outcome.js';
import { type LeadEnrichmentInput, type ManualInput } from '../integrations/enrichment/provider.js';
import { type VerifyOptions } from '../domain/enrichment/verify-domain.js';

export interface EnrichBatchItem {
  input: LeadEnrichmentInput;
}

export interface EnrichDeps {
  service: EnrichmentService;
  logger: Logger;
}

export interface EnrichOptions {
  runId: string;
  verify: VerifyOptions;
}

export type EnrichSummary = Record<EnrichmentOutcome, number> & { failed: number; conflicts: number };

function emptySummary(): EnrichSummary {
  return {
    VERIFIED: 0,
    AMBIGUOUS: 0,
    INSUFFICIENT_CONTEXT: 0,
    NO_CANDIDATE: 0,
    NO_VERIFIED_CANDIDATE: 0,
    BROWSER_REQUIRED: 0,
    TRANSIENT_ERROR: 0,
    POLICY_BLOCKED: 0,
    INVALID_INPUT: 0,
    failed: 0,
    conflicts: 0,
  };
}

/** Enrich a batch of leads. Each lead is processed independently and atomically. */
export async function enrichLeads(
  deps: EnrichDeps,
  items: EnrichBatchItem[],
  opts: EnrichOptions,
): Promise<EnrichSummary> {
  const summary = emptySummary();
  for (const item of items) {
    try {
      const result: EnrichmentResult = await deps.service.enrich(item.input, opts.runId, opts.verify);
      summary[result.outcome] += 1;
      if (result.conflict) summary.conflicts += 1;
    } catch (err) {
      summary.failed += 1;
      deps.logger.error(
        { leadId: item.input.leadId, err: err instanceof Error ? err.message : String(err) },
        'enrichment failed (internal)',
      );
    }
  }
  return summary;
}

export type { ManualInput };
