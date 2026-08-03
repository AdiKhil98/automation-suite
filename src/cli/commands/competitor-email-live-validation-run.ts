/**
 * Phase 7A4B — `competitor-email-live-validation-run`. DEFAULT is the deterministic offline MOCK run. A LIVE
 * run requires `--confirm-live` plus every guard (feature flag, paid-call gate, --fixture synthetic-dental,
 * --confirm-no-real-prospect, --max-live-calls 2); any missing guard throws (nonzero) and never falls back to
 * mock. Makes at most one Terra + one Sol call. Writes ONLY a local git-ignored report. NO production DB
 * write, Gmail, Sheets, draft, or send.
 */

import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Logger } from 'pino';
import { type AppConfig } from '../../config/env.js';
import { runLiveValidation, LIVE_FIXTURE_ID } from '../../evaluation/email/live/live-orchestrator.js';
import { buildLiveValidationConfig, buildLiveValidationProvider } from '../../evaluation/email/live/live-provider.js';
import { renderLiveReportText, selectReportsToPrune } from '../../evaluation/email/live/live-report.js';

export interface LiveValidationRunOptions {
  confirmLive?: boolean;
  fixture?: string;
  confirmNoRealProspect?: boolean;
  maxLiveCalls?: string;
  json?: boolean;
  write?: boolean;
  out?: string;
}

const DEFAULT_OUT_DIR = '.local-data/competitor-email-validation/live';
const KEEP_LATEST = 5;

export async function competitorEmailLiveValidationRunCommand(
  config: AppConfig,
  logger: Logger,
  opts: LiveValidationRunOptions,
): Promise<void> {
  const fixtureId = opts.fixture ?? LIVE_FIXTURE_ID;
  const maxLiveCalls = opts.maxLiveCalls === undefined ? 2 : Number.parseInt(opts.maxLiveCalls, 10);

  // Throws (nonzero) on any missing guard under --confirm-live; mock by default. Never mock under live intent.
  const { provider, mode } = buildLiveValidationProvider(config, logger, {
    confirmLive: opts.confirmLive === true,
    fixtureId,
    confirmNoRealProspect: opts.confirmNoRealProspect === true,
    maxLiveCalls,
  });

  const report = await runLiveValidation({
    provider,
    config: buildLiveValidationConfig(config),
    mode,
    fixtureId,
  });

  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderLiveReportText(report));

  const write = opts.write !== false;
  if (write) {
    const dir = opts.out ?? DEFAULT_OUT_DIR;
    await mkdir(dir, { recursive: true });
    const stamp = report.generatedAt.replace(/[:.]/g, '-');
    await writeFile(join(dir, `live-report-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(join(dir, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(join(dir, 'latest.txt'), `${renderLiveReportText(report)}\n`, 'utf8');
    await pruneRetention(dir, config.COMPETITOR_EMAIL_LIVE_VALIDATION_RETENTION_DAYS);
    console.log(`\nSYNTHETIC ${mode} report written to ${dir}/ (git-ignored; ${String(config.COMPETITOR_EMAIL_LIVE_VALIDATION_RETENTION_DAYS)}-day / latest-${String(KEEP_LATEST)} retention).`);
  }

  console.log(`\n${mode} run complete. Combined operator status: ${report.combinedStatus}.`);
  console.log('No production database write, Gmail, Sheets, draft, or send occurred. Advisory only (no go-live decision).');
  if (report.combinedStatus === 'VALIDATION_FAILED') process.exitCode = 1;
}

async function pruneRetention(dir: string, retentionDays: number): Promise<void> {
  const entries = await readdir(dir);
  const files: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of entries) {
    if (!/^live-report-.*\.json$/.test(name)) continue;
    const s = await stat(join(dir, name));
    files.push({ name, mtimeMs: s.mtimeMs });
  }
  for (const name of selectReportsToPrune(files, retentionDays, KEEP_LATEST, new Date())) {
    await unlink(join(dir, name));
  }
}
