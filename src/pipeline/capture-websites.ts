import { type Logger } from 'pino';
import { CaptureService, type CaptureInput } from '../domain/capture/capture-service.js';
import { CAPTURE_OUTCOMES, type CaptureOutcome } from '../domain/capture/capture-outcome.js';

export interface CaptureItem {
  input: CaptureInput;
}

export interface CaptureDeps {
  service: CaptureService;
  logger: Logger;
}

export interface CaptureRunOptions {
  runId: string;
}

export type CaptureSummary = Record<CaptureOutcome, number> & { verified: number; failed: number };

function emptySummary(): CaptureSummary {
  const s = { verified: 0, failed: 0 } as CaptureSummary;
  for (const o of CAPTURE_OUTCOMES) s[o] = 0;
  return s;
}

/** Capture a batch of leads. Each lead renders + writes atomically and independently. */
export async function captureWebsites(
  deps: CaptureDeps,
  items: CaptureItem[],
  opts: CaptureRunOptions,
): Promise<CaptureSummary> {
  const summary = emptySummary();
  for (const item of items) {
    try {
      const r = await deps.service.capture(item.input, opts.runId);
      summary[r.outcome] += 1;
      if (r.verified) summary.verified += 1;
    } catch (err) {
      summary.failed += 1;
      deps.logger.error(
        { leadId: item.input.leadId, err: err instanceof Error ? err.message : String(err) },
        'capture failed (internal)',
      );
    }
  }
  return summary;
}
