import { isApprovableConfidence, validatePackage } from '../../domain/competitor/pattern-validator.js';
import { CompetitorPatternRepository } from '../../persistence/repositories/competitor-pattern.repo.js';
import { type CliContext } from '../context.js';
import { reconstructPackage, recheckSupportingEvidence } from './competitor-pattern-build.js';

export interface CompetitorPatternApproveOptions {
  lead?: string;
  package?: string;
  operator?: string;
  apply?: boolean;
}

/**
 * Phase 7A3A human approval. Dry-run by default. --apply requires an explicit --operator identity and
 * COMPETITOR_PATTERN_ENABLED=true. Transitions DRAFT/REVIEWED → APPROVED ONLY when every validation
 * gate passes (no prohibited claims, source-traceable, approvable confidence). Approval creates NO
 * outreach record, changes NO lead state, modifies NO email, and sends NOTHING.
 */
export async function competitorPatternApproveCommand(ctx: CliContext, opts: CompetitorPatternApproveOptions): Promise<void> {
  if (!opts.package) {
    console.error('Provide --package <package-id> (see competitor-pattern-review).');
    process.exitCode = 1;
    return;
  }
  const reconstructed = await reconstructPackage(ctx, opts.package);
  if (!reconstructed) {
    console.error(`Package not found: ${opts.package}`);
    process.exitCode = 1;
    return;
  }
  const { pkg, competitorNames, row } = reconstructed;

  if (row.status !== 'DRAFT' && row.status !== 'REVIEWED') {
    console.error(`Package ${opts.package} is ${row.status}; only DRAFT/REVIEWED packages can be approved.`);
    process.exitCode = 1;
    return;
  }

  // Re-validate the exact stored package (defense in depth).
  const validation = validatePackage(pkg, competitorNames);
  const confidenceOk = isApprovableConfidence(pkg.confidence);
  // Re-evaluate supporting evidence against LIVE state at approval time — never trust the package's
  // stored generation-time freshness. Evidence that went stale/superseded/invalidated/unsafe blocks it.
  const freshnessFailures = await recheckSupportingEvidence(ctx, pkg, new Date());
  const gates: string[] = [];
  if (!validation.ok) gates.push(...validation.errors.map((e) => `validation: ${e}`));
  if (!confidenceOk) gates.push(`confidence ${pkg.confidence} is not approvable (requires HIGH or MEDIUM)`);
  if (pkg.prohibitedClaims.length > 0) gates.push(`stored prohibited claims present: ${pkg.prohibitedClaims.join(', ')}`);
  gates.push(...freshnessFailures.map((f) => `freshness: ${f}`));

  console.log(`\nCompetitor pattern APPROVE ${opts.apply ? '(APPLY)' : '(DRY RUN)'} — package ${opts.package}`);
  console.log(`  status: ${row.status}  confidence: ${pkg.confidence}  patterns: ${String(pkg.patterns.length)}  contrasts: ${String(pkg.contrasts.length)}`);

  if (gates.length > 0) {
    console.error('\n  Cannot approve — unresolved gates:');
    for (const g of gates) console.error(`    ✗ ${g}`);
    process.exitCode = 1;
    return;
  }
  console.log('  All validation gates pass.');

  if (!opts.apply) {
    console.log('\n  DRY RUN — no change. Re-run with --apply --operator <name> to approve.');
    return;
  }
  if (!opts.operator || opts.operator.trim() === '') {
    console.error('\n  Refusing to approve: --operator <identity> is required for an explicit human approval.');
    process.exitCode = 1;
    return;
  }
  if (!ctx.config.COMPETITOR_PATTERN_ENABLED) {
    console.error('\n  Refusing to approve: COMPETITOR_PATTERN_ENABLED=false. Persisted approval requires the flag = true.');
    process.exitCode = 1;
    return;
  }

  const repo = new CompetitorPatternRepository(ctx.db);
  const changed = await repo.approvePackage(opts.package, opts.operator.trim(), new Date());
  console.log(changed
    ? `\n  APPROVED package ${opts.package} by ${opts.operator.trim()}. No outreach record, lead-state change, email, or send occurred.`
    : `\n  No change: package ${opts.package} was not in an approvable state (concurrent transition?).`);
}
