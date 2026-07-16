import { type Logger } from 'pino';
import { DEMO_OUTCOMES, type DemoOutcome } from '../domain/demo/demo-types.js';
import { type DemoInput, type DemoService } from '../domain/demo/demo-service.js';

export interface DemoItem {
  input: DemoInput;
}

export interface DemoDeps {
  service: DemoService;
  logger: Logger;
}

export interface DemoRunOptions {
  runId: string;
}

export type DemoSummary = Record<DemoOutcome, number> & { failed: number; paths: string[] };

function emptySummary(): DemoSummary {
  const s = { failed: 0, paths: [] as string[] } as DemoSummary;
  for (const o of DEMO_OUTCOMES) s[o] = 0;
  return s;
}

/** Generate demos for a batch of leads. Each lead is independent and atomic. */
export async function generateDemos(deps: DemoDeps, items: DemoItem[], opts: DemoRunOptions): Promise<DemoSummary> {
  const summary = emptySummary();
  for (const item of items) {
    try {
      const r = await deps.service.generate(item.input, opts.runId);
      summary[r.outcome] += 1;
      if (r.demoPath) summary.paths.push(r.demoPath);
    } catch (err) {
      summary.failed += 1;
      deps.logger.error({ leadId: item.input.leadId, err: err instanceof Error ? err.message : String(err) }, 'demo generation failed (internal)');
    }
  }
  return summary;
}
