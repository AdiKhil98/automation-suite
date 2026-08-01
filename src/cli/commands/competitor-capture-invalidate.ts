import { CompetitorCaptureRepository } from '../../persistence/repositories/competitor-capture.repo.js';
import { type CliContext } from '../context.js';

export interface CompetitorCaptureInvalidateOptions {
  lead?: string;
  evidence?: string;
  apply?: boolean;
}

/**
 * Phase 7A2 operator-controlled invalidation/supersession of a single active evidence item. Dry-run by
 * default. --apply marks the item inactive + unsafe + UNREPRODUCIBLE (immutable history preserved — the
 * row is never deleted). Idempotent: invalidating an already-inactive item is a no-op.
 */
export async function competitorCaptureInvalidateCommand(ctx: CliContext, opts: CompetitorCaptureInvalidateOptions): Promise<void> {
  if (!opts.lead || !opts.evidence) {
    console.error('Provide --lead <lead-id> and --evidence <evidence-id>.');
    process.exitCode = 1;
    return;
  }
  const repo = new CompetitorCaptureRepository(ctx.db);
  const runs = await repo.listRunsForLead(opts.lead);
  let target: { runId: string; active: boolean } | null = null;
  for (const run of runs) {
    const evidence = await repo.getEvidence(run.id);
    const item = evidence.find((e) => e.id === opts.evidence);
    if (item) {
      target = { runId: run.id, active: item.active };
      break;
    }
  }
  if (!target) {
    console.error(`Evidence item ${opts.evidence} not found for lead ${opts.lead}.`);
    process.exitCode = 1;
    return;
  }

  if (!target.active) {
    console.log(`Evidence ${opts.evidence} is already inactive (run ${target.runId}). Nothing to do (idempotent).`);
    return;
  }

  if (!opts.apply) {
    console.log(`DRY RUN — evidence ${opts.evidence} (run ${target.runId}) would be invalidated (active→false, safe→false, freshness→UNREPRODUCIBLE). History preserved.`);
    console.log('Re-run with --apply to perform the invalidation.');
    return;
  }

  const changed = await repo.invalidateEvidence(opts.evidence);
  console.log(changed
    ? `Invalidated evidence ${opts.evidence} (run ${target.runId}). The row remains for historical traceability but is no longer active or safe-for-outreach.`
    : `No change: evidence ${opts.evidence} was already inactive.`);
}
