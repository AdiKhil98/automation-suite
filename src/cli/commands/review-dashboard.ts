import { ReviewService } from '../../domain/review/review-service.js';
import { createReviewServer } from '../../dashboard/server.js';
import { DrizzleReviewUnitOfWork } from '../../persistence/review-unit-of-work.js';
import { ReviewReadRepository } from '../../persistence/repositories/review.repo.js';
import { type CliContext } from '../context.js';

/**
 * Start the local review dashboard on LOOPBACK ONLY (127.0.0.1). Read-only inspection plus
 * demo/email approve-reject with per-session CSRF + same-origin POST checks. No auth, no
 * sending, no deployment — a local operator tool.
 */
export async function reviewDashboardCommand(ctx: CliContext, opts: { signal?: AbortSignal } = {}): Promise<void> {
  const c = ctx.config;
  if (!c.REVIEW_DASHBOARD_ENABLED) {
    console.log('Review dashboard is disabled (REVIEW_DASHBOARD_ENABLED=false).');
    return;
  }

  const service = new ReviewService({
    uow: new DrizzleReviewUnitOfWork(ctx.db),
    read: new ReviewReadRepository(ctx.db),
    logger: ctx.logger,
  });
  const { server } = createReviewServer({ service, demoOutputDir: c.DEMO_OUTPUT_DIR, logger: ctx.logger });

  await new Promise<void>((resolveStart, rejectStart) => {
    // 127.0.0.1 = loopback only. Never 0.0.0.0.
    server.listen(c.REVIEW_DASHBOARD_PORT, '127.0.0.1', () => {
      console.log(`\nReview dashboard (local only): http://127.0.0.1:${String(c.REVIEW_DASHBOARD_PORT)}/`);
      console.log('Approvals: demo and email are independent. No sending, no deployment. Ctrl+C to stop.');
      resolveStart();
    });
    server.on('error', rejectStart);
  });

  // Keep the command (and therefore the shared DB pool in withContext) alive until the
  // server closes or the operator presses Ctrl+C. Resolving earlier would let withContext
  // end the pool while the server is still handling requests. `opts.signal` gives tests (and
  // programmatic callers) a clean shutdown without process signals.
  await new Promise<void>((resolveClose) => {
    const done = (): void => {
      process.removeListener('SIGINT', shutdown);
      process.removeListener('SIGTERM', shutdown);
      resolveClose();
    };
    const shutdown = (): void => { server.close(() => done()); };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    opts.signal?.addEventListener('abort', shutdown, { once: true });
    server.once('close', () => resolveClose());
  });
}
