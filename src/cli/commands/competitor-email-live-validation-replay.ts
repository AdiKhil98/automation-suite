/**
 * Phase 7A4B1 — `competitor-email-live-validation-replay`: OFFLINE determinism replay. Loads a saved live
 * report (default `.local-data/competitor-email-validation/live/latest.json`), re-derives the deterministic
 * package, enrichment, claim spans, composed-message hash, and hard gates, and reports whether the composed
 * hash + claim spans are reproducible — with ZERO Terra/Sol calls, network requests, Gmail/Sheets access,
 * drafts, sends, or production database writes. It exits nonzero when the artifact is incomplete/altered
 * (report-hash mismatch) or when the composed hash / claim spans are not reproducible.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { replayLiveValidation, renderReplayResult } from '../../evaluation/email/live/replay.js';
import { type LiveValidationReport } from '../../evaluation/email/live/live-report.js';

export interface LiveValidationReplayOptions {
  report?: string;
  out?: string;
  json?: boolean;
}

const DEFAULT_OUT_DIR = '.local-data/competitor-email-validation/live';

export async function competitorEmailLiveValidationReplayCommand(opts: LiveValidationReplayOptions): Promise<void> {
  const path = opts.report ?? join(opts.out ?? DEFAULT_OUT_DIR, 'latest.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    console.error(`No saved live report at ${path}. Run competitor-email-live-validation-run first.`);
    process.exitCode = 1;
    return;
  }

  let report: LiveValidationReport;
  try {
    report = JSON.parse(raw) as LiveValidationReport;
  } catch {
    console.error(`Saved live report at ${path} is not valid JSON (altered or truncated).`);
    process.exitCode = 1;
    return;
  }

  const result = await replayLiveValidation(report);
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderReplayResult(result));

  if (!result.ok) process.exitCode = 1;
}
