/**
 * Phase 7A4A — `competitor-email-validation-review`: read-only. Loads a previously written validation
 * report (default `.local-data/competitor-email-validation/report.json`) and re-renders it, including the
 * claim traceability. Verifies the report's determinism hash. NO writes, network, database, or model.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashReport, renderReportText, type ValidationReport } from '../../evaluation/email/validation-report.js';

export interface ValidationReviewOptions {
  report?: string;
  out?: string;
}

const DEFAULT_OUT_DIR = '.local-data/competitor-email-validation';

export async function competitorEmailValidationReviewCommand(opts: ValidationReviewOptions): Promise<void> {
  const path = opts.report ?? join(opts.out ?? DEFAULT_OUT_DIR, 'report.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    console.error(`No saved report at ${path}. Run competitor-email-validation-run first.`);
    process.exitCode = 1;
    return;
  }
  const report = JSON.parse(raw) as ValidationReport;
  console.log(renderReportText(report));

  const recomputed = hashReport(report);
  const stable = recomputed === report.determinismHash;
  console.log(`\ndeterminism hash ${stable ? 'VERIFIED' : 'MISMATCH'} (${recomputed.slice(0, 16)}${stable ? '' : ` != stored ${report.determinismHash.slice(0, 16)}`}).`);
  if (!stable) process.exitCode = 1;
}
