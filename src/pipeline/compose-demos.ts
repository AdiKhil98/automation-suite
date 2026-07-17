import { type Logger } from 'pino';
import { type ComposerInput, type ComposerOutcome, type DemoComposerService } from '../domain/demo/composer/demo-composer-service.js';

export interface ComposeItem {
  input: ComposerInput;
}

export interface ComposeDeps {
  service: DemoComposerService;
  logger: Logger;
}

export interface ComposeRunOptions {
  runId: string;
}

const COMPOSE_OUTCOMES: ComposerOutcome[] = [
  'DEMO_COMPOSED', 'SPEC_INVALID', 'RENDER_INVALID', 'REVIEW_REJECTED',
  'SCHEMA_INVALID', 'BUDGET_BLOCKED', 'MODEL_REFUSAL', 'RATE_LIMITED', 'TRANSIENT_PROVIDER_ERROR',
];

export type ComposeSummary = Record<ComposerOutcome, number> & { failed: number; paths: string[]; totalCostUsd: number };

function emptySummary(): ComposeSummary {
  const s = { failed: 0, paths: [] as string[], totalCostUsd: 0 } as ComposeSummary;
  for (const o of COMPOSE_OUTCOMES) s[o] = 0;
  return s;
}

/** Compose AI demos for a batch of leads. Each lead is independent and atomic. */
export async function composeDemos(deps: ComposeDeps, items: ComposeItem[], opts: ComposeRunOptions): Promise<ComposeSummary> {
  const summary = emptySummary();
  for (const item of items) {
    try {
      const r = await deps.service.compose(item.input, opts.runId);
      summary[r.outcome] += 1;
      summary.totalCostUsd += r.costUsd;
      if (r.demoPath) summary.paths.push(r.demoPath);
    } catch (err) {
      summary.failed += 1;
      deps.logger.error({ leadId: item.input.leadId, err: err instanceof Error ? err.message : String(err) }, 'demo composition failed (internal)');
    }
  }
  return summary;
}
