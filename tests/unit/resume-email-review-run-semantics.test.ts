import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * PIPELINE RUN SEMANTICS for `resume-email-review`.
 *
 * The question raised by the SCHEMA_INVALID production run: should a run whose reviewer produced no
 * usable verdict be recorded as COMPLETED-with-outcome, or as FAILED?
 *
 * The repository already answers it consistently, and this file pins that answer rather than
 * re-deciding it per command:
 *
 *   COMPLETED = the command ran to a determinate conclusion and recorded it in the run summary.
 *               `generate-emails` finishes COMPLETED even when every email it produced was rejected
 *               in review or failed validation; `run-followup-automation` finishes COMPLETED even
 *               when individual follow-ups failed. The per-item outcome lives in the summary.
 *   FAILED    = the run did NOT reach a conclusion: an exception, an interruption
 *               (`collect-leads` when interrupted), or a systemic failure (`prospect-run`).
 *
 * SCHEMA_INVALID is a determinate conclusion: exactly one reviewer call was made, its cost and
 * model_call were committed, a diagnostic was recorded, and the draft was deliberately left
 * resumable. Recording that as FAILED would conflate "the model's output was unusable" with "the
 * process broke", and would make an ordinary retryable outcome look like an infrastructure incident
 * in run-level reporting. The abort path — where nothing was concluded and nothing was spent —
 * already marks the run FAILED, and that remains the boundary.
 */

const SOURCE = readFileSync(new URL('../../src/cli/commands/resume-email-review.ts', import.meta.url), 'utf8');

describe('resume-email-review run status', () => {
  it('records a determinate outcome as COMPLETED, with the outcome in the summary', () => {
    expect(SOURCE).toContain("await runs.finish(runId, 'COMPLETED', JSON.stringify(r));");
  });

  it('reserves FAILED for a run that reached no conclusion', () => {
    const failures = [...SOURCE.matchAll(/runs\.finish\([^)]*'FAILED'/g)];
    expect(failures).toHaveLength(1);
    // ...and it lives in the catch, after which the abort is reported and nothing was persisted.
    const catchBlock = SOURCE.slice(SOURCE.indexOf('} catch (err) {'));
    expect(catchBlock).toContain("runs.finish(runId, 'FAILED'");
    expect(catchBlock).toContain('No reviewer call was made and nothing was persisted.');
  });

  it('tells the operator a failed paid attempt was recorded and is retryable', () => {
    expect(SOURCE).toContain('the paid reviewer call was recorded against the draft; the draft is unchanged and still resumable.');
  });
});
