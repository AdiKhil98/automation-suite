/**
 * Phase 7A4B2 — `competitor-email-live-validation-recompose`: OFFLINE recomposition of a saved FULL live
 * report. Loads a saved live report (default `.local-data/competitor-email-validation/live/latest.json`),
 * verifies its integrity, reuses the EXACT saved Terra base draft, rebuilds the enriched email + claim
 * ledger + hashes with the CURRENT deterministic templates, reruns the deterministic rubric and ALL hard
 * gates, and writes a NEW local recomposition report (never overwriting the source). It makes ZERO Terra/Sol
 * calls, network requests, Gmail/Sheets access, drafts, sends, or production database writes. It exits
 * nonzero when the source artifact is incomplete/altered or when the recomposed result is not a
 * deterministic PASS.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { recomposeLiveValidation, renderRecompositionResult } from '../../evaluation/email/live/recompose.js';
import { type LiveValidationReport } from '../../evaluation/email/live/live-report.js';

export interface LiveValidationRecomposeOptions {
  report?: string;
  out?: string;
  json?: boolean;
  write?: boolean;
}

const DEFAULT_OUT_DIR = '.local-data/competitor-email-validation/live';

export async function competitorEmailLiveValidationRecomposeCommand(opts: LiveValidationRecomposeOptions): Promise<void> {
  const dir = opts.out ?? DEFAULT_OUT_DIR;
  const path = opts.report ?? join(dir, 'latest.json');

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

  const result = await recomposeLiveValidation(report);
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderRecompositionResult(result));

  // Write a NEW recomposition report; NEVER overwrite the source live artifact.
  const write = opts.write !== false;
  if (write) {
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const payload = { sourceReportPath: path, sourceReportHash: result.sourceReportHash, generatedAt: new Date().toISOString(), result };
    const outPath = join(dir, `recompose-report-${stamp}.json`);
    await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await writeFile(join(dir, 'recompose-latest.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`\nRecomposition report written to ${outPath} (git-ignored). Source artifact left unchanged.`);
  }

  if (!result.ok) process.exitCode = 1;
}
