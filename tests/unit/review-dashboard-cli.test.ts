import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { reviewDashboardCommand } from '../../src/cli/commands/review-dashboard.js';
import { type CliContext } from '../../src/cli/context.js';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Minimal CLI context. `db` is never queried here because no HTTP request is made — the
 * test exercises only the command's serve-until-shutdown lifecycle. Port 0 = ephemeral. */
function ctx(enabled = true): CliContext {
  return {
    config: { REVIEW_DASHBOARD_ENABLED: enabled, REVIEW_DASHBOARD_PORT: 0, DEMO_OUTPUT_DIR: './demos' },
    db: {} as never,
    logger: pino({ level: 'silent' }),
  } as unknown as CliContext;
}

describe('reviewDashboardCommand lifecycle', () => {
  it('returns immediately when the dashboard is disabled', async () => {
    await expect(reviewDashboardCommand(ctx(false))).resolves.toBeUndefined();
  });

  it('stays pending while serving (so withContext keeps the DB pool open) and resolves on shutdown', async () => {
    const ac = new AbortController();
    let resolved = false;
    const p = reviewDashboardCommand(ctx(), { signal: ac.signal }).then(() => { resolved = true; });

    // After the server is listening, the command MUST still be pending. If it resolved here,
    // withContext's `finally { pool.end() }` would run and close the shared DB pool while the
    // dashboard is still serving requests — the regression this guards against.
    await delay(150);
    expect(resolved).toBe(false);

    // Clean shutdown (Ctrl+C / SIGTERM use the same path) resolves the command.
    ac.abort();
    await p;
    expect(resolved).toBe(true);
  });
});
