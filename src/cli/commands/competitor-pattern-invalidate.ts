import { CompetitorPatternRepository } from '../../persistence/repositories/competitor-pattern.repo.js';
import { type CliContext } from '../context.js';

export interface CompetitorPatternInvalidateOptions {
  package?: string;
  operator?: string;
  apply?: boolean;
}

/**
 * Phase 7A3A operator invalidation of a package (e.g. underlying evidence changed). Dry-run by default.
 * --apply requires --operator identity and COMPETITOR_PATTERN_ENABLED=true. Any non-terminal package
 * (DRAFT/REVIEWED/APPROVED) → INVALIDATED. Immutable history and all evidence references are preserved
 * (nothing is deleted). Sends nothing; touches no email/Gmail/Sheets.
 */
export async function competitorPatternInvalidateCommand(ctx: CliContext, opts: CompetitorPatternInvalidateOptions): Promise<void> {
  if (!opts.package) {
    console.error('Provide --package <package-id>.');
    process.exitCode = 1;
    return;
  }
  const repo = new CompetitorPatternRepository(ctx.db);
  const row = await repo.getPackage(opts.package);
  if (!row) {
    console.error(`Package not found: ${opts.package}`);
    process.exitCode = 1;
    return;
  }
  if (row.status === 'INVALIDATED') {
    console.log(`Package ${opts.package} is already INVALIDATED. Nothing to do (idempotent).`);
    return;
  }
  if (row.status === 'SUPERSEDED' || row.status === 'REJECTED') {
    console.error(`Package ${opts.package} is ${row.status}; only DRAFT/REVIEWED/APPROVED packages can be invalidated.`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nCompetitor pattern INVALIDATE ${opts.apply ? '(APPLY)' : '(DRY RUN)'} — package ${opts.package} (status ${row.status})`);
  if (!opts.apply) {
    console.log('  DRY RUN — no change. Re-run with --apply --operator <name> to invalidate. History + evidence refs preserved.');
    return;
  }
  if (!opts.operator || opts.operator.trim() === '') {
    console.error('  Refusing to invalidate: --operator <identity> is required.');
    process.exitCode = 1;
    return;
  }
  if (!ctx.config.COMPETITOR_PATTERN_ENABLED) {
    console.error('  Refusing to invalidate: COMPETITOR_PATTERN_ENABLED=false. Persisted status changes require the flag = true.');
    process.exitCode = 1;
    return;
  }

  const changed = await repo.invalidatePackage(opts.package, opts.operator.trim(), new Date());
  console.log(changed
    ? `  INVALIDATED package ${opts.package} by ${opts.operator.trim()}. History + evidence references preserved (nothing deleted).`
    : `  No change: package ${opts.package} could not be invalidated (concurrent transition?).`);
}
