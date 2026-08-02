import { CompetitorPatternRepository } from '../../persistence/repositories/competitor-pattern.repo.js';
import { type CliContext } from '../context.js';

export interface CompetitorPatternRejectOptions {
  package?: string;
  operator?: string;
  apply?: boolean;
}

/**
 * Phase 7A3A explicit operator rejection of a DRAFT/REVIEWED package. Dry-run by default. --apply
 * requires --operator identity and COMPETITOR_PATTERN_ENABLED=true. Immutable history is preserved —
 * the package is stamped REJECTED, never deleted. Sends nothing, touches no email/Gmail/Sheets.
 */
export async function competitorPatternRejectCommand(ctx: CliContext, opts: CompetitorPatternRejectOptions): Promise<void> {
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
  if (row.status !== 'DRAFT' && row.status !== 'REVIEWED') {
    console.error(`Package ${opts.package} is ${row.status}; only DRAFT/REVIEWED packages can be rejected.`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nCompetitor pattern REJECT ${opts.apply ? '(APPLY)' : '(DRY RUN)'} — package ${opts.package} (status ${row.status})`);
  if (!opts.apply) {
    console.log('  DRY RUN — no change. Re-run with --apply --operator <name> to reject. History is preserved.');
    return;
  }
  if (!opts.operator || opts.operator.trim() === '') {
    console.error('  Refusing to reject: --operator <identity> is required.');
    process.exitCode = 1;
    return;
  }
  if (!ctx.config.COMPETITOR_PATTERN_ENABLED) {
    console.error('  Refusing to reject: COMPETITOR_PATTERN_ENABLED=false. Persisted status changes require the flag = true.');
    process.exitCode = 1;
    return;
  }

  const changed = await repo.rejectPackage(opts.package, opts.operator.trim(), new Date());
  console.log(changed
    ? `  REJECTED package ${opts.package} by ${opts.operator.trim()}. History preserved (row not deleted).`
    : `  No change: package ${opts.package} was not in a rejectable state.`);
}
