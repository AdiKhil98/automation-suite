/**
 * Phase 7A4B — `competitor-email-live-validation-review`: read-only. Loads a saved live report (default
 * `.local-data/competitor-email-validation/live/latest.json`), re-renders it (routing, budget, deterministic
 * result, Sol advisory critique, combined status), and verifies its stable report hash. NO model call,
 * network, or write.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashLiveReport, renderLiveReportText, type LiveValidationReport } from '../../evaluation/email/live/live-report.js';

export interface LiveValidationReviewOptions {
  report?: string;
  out?: string;
}

const DEFAULT_OUT_DIR = '.local-data/competitor-email-validation/live';

export async function competitorEmailLiveValidationReviewCommand(opts: LiveValidationReviewOptions): Promise<void> {
  const path = opts.report ?? join(opts.out ?? DEFAULT_OUT_DIR, 'latest.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    console.error(`No saved live report at ${path}. Run competitor-email-live-validation-run first.`);
    process.exitCode = 1;
    return;
  }
  const report = JSON.parse(raw) as LiveValidationReport;
  console.log(renderLiveReportText(report));

  const recomputed = hashLiveReport(report);
  const stable = recomputed === report.reportHash;
  console.log(`\nreport hash ${stable ? 'VERIFIED' : 'MISMATCH'} (${recomputed.slice(0, 16)}${stable ? '' : ` != stored ${report.reportHash.slice(0, 16)}`}).`);
  if (!stable) process.exitCode = 1;
}
