import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type DbExecutor } from '../../src/persistence/db.js';
import { PipelineRunsRepository } from '../../src/persistence/repositories/runs.repo.js';
import { pipelineRuns } from '../../src/persistence/schema.js';

/**
 * PIPELINE RUN PROVENANCE for `run-followup-automation`.
 *
 * THE PRODUCTION INCIDENT this file exists to prevent from recurring: an armed run — no `--dry-run`,
 * the CLI correctly printing `dry-run=false`, real paid OpenAI calls, a real persisted email draft —
 * recorded itself in `pipeline_runs` as `dry_run='true'`.
 *
 * The cause was a provenance bug and nothing more: every GATE in the command reads the command-local
 *
 *     const dryRun = cliOpts.dryRun === true;
 *
 * while the run row alone was stamped from the global `c.DRY_RUN` config. This command deliberately
 * takes its mode from `--dry-run` ALONE, and the repository `.env` intentionally carries
 * `DRY_RUN=true` as a safe global default for the commands that DO honour it. Those two facts
 * together made "armed, but recorded as dry" the DEFAULT production outcome — the audit trail
 * claimed nothing was spent and nothing was written on exactly the runs that spent and wrote.
 *
 * Two independent things are pinned here:
 *
 *  1. THE COLUMN (runtime). `PipelineRunsRepository.start` maps the boolean it is handed onto the
 *     `dry_run` text column, so whatever the command passes is literally what an auditor reads back.
 *
 *  2. THE WIRING (static). The command hands that repository its OWN `dryRun`, never config, and a
 *     dry run still returns from every branch BEFORE the run row is ever opened — so a dry run
 *     touches no row, no model, no Gmail and no transaction, exactly as it did before the fix.
 */

const SOURCE = readFileSync(new URL('../../src/cli/commands/run-followup-automation.ts', import.meta.url), 'utf8');

interface RecordedRun {
  kind: string;
  status: string;
  dryRun: string;
}

/** The minimal executor surface `PipelineRunsRepository.start` uses: `insert(table).values(row)`. */
function fakeDb(): { db: DbExecutor; rows: RecordedRun[]; tables: unknown[] } {
  const rows: RecordedRun[] = [];
  const tables: unknown[] = [];
  const db = {
    insert: (table: unknown) => {
      tables.push(table);
      return {
        values: (row: RecordedRun) => {
          rows.push(row);
          return Promise.resolve();
        },
      };
    },
  };
  return { db: db as unknown as DbExecutor, rows, tables };
}

/** Slice one closure out of the command source. Both anchors are unique in the file. */
function closure(startAnchor: string, endAnchor: string): string {
  const a = SOURCE.indexOf(startAnchor);
  expect(a, `missing anchor: ${startAnchor}`).toBeGreaterThan(-1);
  const b = SOURCE.indexOf(endAnchor, a);
  expect(b, `missing anchor: ${endAnchor}`).toBeGreaterThan(a);
  return SOURCE.slice(a, b);
}

const promoteSrc = closure('const promote = async (cand: FollowupPromotionCandidateView)', 'const deps: FollowupPromotionDeps');
const composeSrc = closure('const compose = async (cand: FollowupCandidateView', 'const deps: FollowupPreparationDeps');
const finalizeSrc = closure('const finalize = async (cand: ProgressionCandidateView)', '/** Gmail DRAFT creation');
const gmailSrc = closure('const createGmailDraft = async (cand: ProgressionCandidateView)', '/** Send-time scheduling');
const scheduleSrc = closure('const schedule = async (cand: ProgressionCandidateView)', 'const deps: FollowupProgressionDeps');
const preflightSrc = closure('preflight: () => {', 'maxPerRun:');

/** Assert `earlier` really appears before `later` inside one closure — i.e. it guards it. */
function guards(src: string, earlier: string, later: string): void {
  const a = src.indexOf(earlier);
  const b = src.indexOf(later);
  expect(a, `missing guard: ${earlier}`).toBeGreaterThan(-1);
  expect(b, `missing guarded call: ${later}`).toBeGreaterThan(-1);
  expect(a).toBeLessThan(b);
}

describe('pipeline_runs.dry_run records what the run actually did', () => {
  it('persists dry_run="false" for an ARMED run', async () => {
    const { db, rows, tables } = fakeDb();
    const id = await new PipelineRunsRepository(db).start('outreach:followup-automation', false);

    expect(rows).toHaveLength(1);
    expect(rows[0].dryRun).toBe('false');
    expect(rows[0].kind).toBe('outreach:followup-automation');
    expect(rows[0].status).toBe('RUNNING');
    expect(tables[0]).toBe(pipelineRuns);
    expect(id).toBeTruthy();
  });

  it('persists dry_run="true" for a DRY run', async () => {
    const { db, rows } = fakeDb();
    await new PipelineRunsRepository(db).start('outreach:followup-automation', true);

    expect(rows).toHaveLength(1);
    expect(rows[0].dryRun).toBe('true');
  });
});

describe('run-followup-automation stamps the run from its OWN --dry-run', () => {
  it('derives its execution mode from --dry-run alone', () => {
    expect(SOURCE).toContain('const dryRun = cliOpts.dryRun === true;');
  });

  it('opens the run row with that same command-local value', () => {
    expect(SOURCE).toContain("runs.start('outreach:followup-automation', dryRun)");
  });

  it('REGRESSION: never reads the global DRY_RUN config anywhere in the command', () => {
    // The production bug in one assertion. `.env` ships DRY_RUN=true as a safe default for the
    // commands that honour it; this command does not, so reading it here can only mislabel a run.
    expect(SOURCE).not.toMatch(/\bc\.DRY_RUN\b/);
    expect(SOURCE).not.toMatch(/config\.DRY_RUN\b/);
  });

  it('opens exactly one run row, lazily, from a single place', () => {
    expect([...SOURCE.matchAll(/runs\.start\(/g)]).toHaveLength(1);
    // `??=` memoises: the first real effect opens the row, every later effect reuses it.
    expect(SOURCE).toContain('runId ??= await runs.start(');
  });

  it('attaches that run id to the paid model call and to the Gmail draft call', () => {
    expect(composeSrc).toContain('await getRunId()');
    expect(gmailSrc).toContain('await getRunId()');
  });
});

describe('a dry run still opens no run row and produces no effect', () => {
  it('never reaches the run row: promotion and finalization do not open one at all', () => {
    expect(promoteSrc).not.toContain('getRunId');
    expect(finalizeSrc).not.toContain('getRunId');
  });

  it('never reaches the run row: preparation returns before opening one', () => {
    guards(composeSrc, 'if (dryRun) {', 'await getRunId()');
  });

  it('never reaches the run row: Gmail draft creation returns before opening one', () => {
    guards(gmailSrc, 'if (dryRun) return', 'await getRunId()');
  });

  it('never reaches the run row: scheduling passes no run id on a dry run', () => {
    expect(scheduleSrc).toContain("dryRun ? '' : await getRunId()");
    expect(scheduleSrc).toContain('{ dryRun }');
  });

  it('makes NO model call: the provider preflight and the writer are both behind the dry guard', () => {
    guards(preflightSrc, 'if (dryRun) return;', 'assertUnattendedPreparationProvider(');
    guards(composeSrc, 'if (dryRun) {', 'getEmailService()');
    guards(composeSrc, 'if (dryRun) {', 'service.write(');
  });

  it('makes NO Gmail call: the Gmail service is built only past the dry guard', () => {
    guards(gmailSrc, 'if (dryRun) return', 'getGmail()');
  });

  it('writes NOTHING: promotion, cancellation and finalization all return before their write', () => {
    guards(promoteSrc, 'if (dryRun) {', 'outreach.promoteFollowupDue(');
    expect(SOURCE).toContain('cancelFollowup: async (followupId, recordId, reason) => {\n        if (dryRun) return;');
    guards(finalizeSrc, 'if (dryRun) return', 'ctx.db.transaction(');
  });
});
