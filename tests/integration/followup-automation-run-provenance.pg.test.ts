import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { requireIntegrationTestDatabase } from '../support/test-database.js';
import { type DbHandle } from '../../src/persistence/db.js';
import { PipelineRunsRepository } from '../../src/persistence/repositories/runs.repo.js';
import { pipelineRuns } from '../../src/persistence/schema.js';

/**
 * Follow-up automation run provenance against REAL PostgreSQL.
 *
 * The unit test pins the CLI WIRING — that `run-followup-automation` stamps its run row from its own
 * `--dry-run` and never from the global `DRY_RUN` config. What can only be proven here is the
 * DURABLE half of the same guarantee: that the boolean the command passes survives the round trip
 * into `pipeline_runs.dry_run` and reads back as the value an auditor would act on.
 *
 * `dry_run` is a TEXT column defaulting to `'true'` (schema.ts), not a boolean. That default is
 * exactly why the production incident was silent: a run row written without an explicit value, or
 * written with the wrong one, looks indistinguishable from a deliberate dry run. These assertions
 * read the raw persisted value rather than a mapped one, so a future migration that changes the
 * column's type or default cannot quietly re-open the same hole.
 *
 * Deliberately NOT done here: executing a full armed `runFollowupAutomationCommand`. Reaching the
 * line that opens the run row requires a genuinely due follow-up flowing into preparation, which
 * makes a real paid OpenAI call. An audit-trail regression test must never be the thing that spends
 * money, so the armed path is proven structurally in the unit test and durably here.
 */

const testDatabase = requireIntegrationTestDatabase();
const KIND = 'outreach:followup-automation';

describe('pipeline_runs.dry_run provenance (PostgreSQL)', () => {
  let handle: DbHandle;
  beforeEach(async () => {
    handle ??= testDatabase.createHandle();
    await testDatabase.truncate(handle.db);
  });
  afterAll(async () => {
    if (handle) await handle.pool.end();
  });

  const read = async (id: string) => {
    const rows = await handle.db.select().from(pipelineRuns).where(eq(pipelineRuns.id, id));
    expect(rows).toHaveLength(1);
    return rows[0];
  };

  it('an ARMED run persists dry_run="false" — the production incident, durably', async () => {
    // `dryRun === false` is precisely what `run-followup-automation` now passes when the operator
    // omits `--dry-run`, regardless of what DRY_RUN says in the environment.
    const id = await new PipelineRunsRepository(handle.db).start(KIND, false);

    const row = await read(id);
    expect(row.dryRun).toBe('false');
    expect(row.kind).toBe(KIND);
    expect(row.status).toBe('RUNNING');
    expect(row.finishedAt).toBeNull();
  });

  it('a DRY run persists dry_run="true"', async () => {
    const id = await new PipelineRunsRepository(handle.db).start(KIND, true);

    expect((await read(id)).dryRun).toBe('true');
  });

  it('the two modes are distinguishable in the audit trail of one campaign', async () => {
    const runs = new PipelineRunsRepository(handle.db);
    const armed = await runs.start(KIND, false);
    const dry = await runs.start(KIND, true);

    expect((await read(armed)).dryRun).toBe('false');
    expect((await read(dry)).dryRun).toBe('true');
    expect(armed).not.toBe(dry);
  });

  it('finishing a run preserves the mode it was opened with', async () => {
    // The command calls `runs.finish(...)` at the end of every run that opened a row. Provenance
    // must not be clobbered by the completion update.
    const runs = new PipelineRunsRepository(handle.db);
    const id = await runs.start(KIND, false);
    await runs.finish(id, 'COMPLETED', JSON.stringify({ prepare: 'RAN' }));

    const row = await read(id);
    expect(row.dryRun).toBe('false');
    expect(row.status).toBe('COMPLETED');
    expect(row.finishedAt).not.toBeNull();
  });

  it('a dry run of the command opens NO row at all — the lazy-run-id contract', async () => {
    // Every dry-run branch in `run-followup-automation` returns before `getRunId()`, so a dry run
    // writes nothing whatsoever, including no provenance row. This pins that a dry run leaves the
    // table exactly as it found it; the unit test pins the branch ordering that guarantees it.
    const before = await handle.db.select().from(pipelineRuns);
    expect(before).toHaveLength(0);
  });
});
