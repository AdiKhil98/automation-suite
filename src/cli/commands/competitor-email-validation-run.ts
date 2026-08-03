/**
 * Phase 7A4A — `competitor-email-validation-run`: fixture-only, offline. Runs the complete
 * baseline-vs-enriched comparison through the real Phase 7A1–7A3B services (in-memory adapters), builds
 * the structured report, prints it, and writes it to the git-ignored `.local-data/competitor-email-
 * validation/` directory. NO production database write, NO network, NO live model, NO Gmail/Sheets/draft/send.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runValidationHarness } from '../../evaluation/email/harness.js';
import { buildReport, renderReportText } from '../../evaluation/email/validation-report.js';

export interface ValidationRunOptions {
  json?: boolean;
  write?: boolean;
  out?: string;
}

const DEFAULT_OUT_DIR = '.local-data/competitor-email-validation';

export async function competitorEmailValidationRunCommand(opts: ValidationRunOptions): Promise<void> {
  const outcome = await runValidationHarness();
  const report = buildReport(outcome);

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderReportText(report));
  }

  const write = opts.write !== false; // default: write the local report
  if (write) {
    const dir = opts.out ?? DEFAULT_OUT_DIR;
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(join(dir, 'report.txt'), `${renderReportText(report)}\n`, 'utf8');
    console.log(`\nSYNTHETIC report written to ${dir}/report.json and report.txt (git-ignored).`);
  }

  console.log('\nfixture-only run complete. No network, database write, live model, Gmail, Sheets, draft, or send occurred.');
  if (report.result === 'FAIL') process.exitCode = 1;
}
