/**
 * Phase 7A4B2 — `competitor-email-live-validation-rereview`: guarded Sol-ONLY re-review. Loads a valid full
 * source live report (default `.local-data/competitor-email-validation/live/latest.json`), reuses its EXACT
 * saved Terra base draft (NO Terra call), recomposes with the current deterministic templates, requires a
 * deterministic PASS, and — under `--confirm-live` plus every guard — makes EXACTLY ONE advisory Sol call. It
 * never retries, never falls back to mock under live intent, and never modifies either email after Sol. It
 * writes a NEW local report linked to the source (never overwriting it). Mock by default (offline). No
 * production DB, Gmail, Sheets, draft, or send.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Logger } from 'pino';
import { type AppConfig } from '../../config/env.js';
import { buildLiveValidationConfig, buildSolRereviewProvider } from '../../evaluation/email/live/live-provider.js';
import { runSolOnlyRereview, RereviewSourceError } from '../../evaluation/email/live/rereview.js';
import { renderLiveReportText } from '../../evaluation/email/live/live-report.js';
import { LIVE_FIXTURE_ID } from '../../evaluation/email/live/live-orchestrator.js';
import { type LiveValidationReport } from '../../evaluation/email/live/live-report.js';

export interface LiveValidationRereviewOptions {
  report?: string;
  confirmLive?: boolean;
  fixture?: string;
  confirmNoRealProspect?: boolean;
  maxLiveCalls?: string;
  json?: boolean;
  write?: boolean;
  out?: string;
}

const DEFAULT_OUT_DIR = '.local-data/competitor-email-validation/live';

export async function competitorEmailLiveValidationRereviewCommand(
  config: AppConfig,
  logger: Logger,
  opts: LiveValidationRereviewOptions,
): Promise<void> {
  const dir = opts.out ?? DEFAULT_OUT_DIR;
  const sourcePath = opts.report ?? join(dir, 'latest.json');
  const fixtureId = opts.fixture ?? LIVE_FIXTURE_ID;
  const maxLiveCalls = opts.maxLiveCalls === undefined ? 1 : Number.parseInt(opts.maxLiveCalls, 10);

  let raw: string;
  try {
    raw = await readFile(sourcePath, 'utf8');
  } catch {
    console.error(`No saved live report at ${sourcePath}. Run competitor-email-live-validation-run first.`);
    process.exitCode = 1;
    return;
  }
  let source: LiveValidationReport;
  try {
    source = JSON.parse(raw) as LiveValidationReport;
  } catch {
    console.error(`Saved live report at ${sourcePath} is not valid JSON (altered or truncated).`);
    process.exitCode = 1;
    return;
  }

  // Throws (nonzero) on any missing guard under --confirm-live; mock by default. Never mock under live intent.
  const { provider, mode } = buildSolRereviewProvider(config, logger, {
    confirmLive: opts.confirmLive === true,
    fixtureId,
    confirmNoRealProspect: opts.confirmNoRealProspect === true,
    maxLiveCalls,
  });

  let report: LiveValidationReport;
  try {
    report = await runSolOnlyRereview({
      provider,
      config: buildLiveValidationConfig(config),
      mode,
      source,
      fixtureId,
    });
  } catch (err) {
    if (err instanceof RereviewSourceError) {
      console.error(`Source artifact rejected: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderLiveReportText(report));
  console.log(`\nSol-only re-review of source report ${source.reportHash.slice(0, 16)} (${mode}).`);

  const write = opts.write !== false;
  if (write) {
    await mkdir(dir, { recursive: true });
    const stamp = report.generatedAt.replace(/[:.]/g, '-');
    await writeFile(join(dir, `rereview-report-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(join(dir, 'rereview-latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(join(dir, 'rereview-latest.txt'), `${renderLiveReportText(report)}\n`, 'utf8');
    console.log(`Re-review report written to ${dir}/rereview-* (git-ignored). Source artifact left unchanged.`);
  }

  console.log('\nNo Terra call, network beyond the single Sol call, production DB, Gmail, Sheets, draft, or send occurred. Advisory only.');
  if (report.combinedStatus === 'VALIDATION_FAILED') process.exitCode = 1;
}
