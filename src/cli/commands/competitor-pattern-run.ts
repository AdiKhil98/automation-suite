import { CompetitorPatternService } from '../../domain/competitor/pattern-service.js';
import { DrizzleCompetitorPatternUnitOfWork } from '../../persistence/competitor-pattern-unit-of-work.js';
import { type CliContext } from '../context.js';
import { resolvePatternInput } from './competitor-pattern-build.js';

export interface CompetitorPatternRunOptions {
  lead?: string;
  researchRun?: string;
  captureRun?: string;
  apply?: boolean;
}

/**
 * Phase 7A3A: build a deterministic competitor pattern package for ONE lead + ONE approved
 * research/capture set. Dry report by default; --apply persists an immutable DRAFT package (requires
 * COMPETITOR_PATTERN_ENABLED=true). Idempotent: an identical eligible evidence set reuses the existing
 * version. NEVER composes/drafts/sends email, calls AI, or touches Gmail/Sheets/network.
 */
export async function competitorPatternRunCommand(ctx: CliContext, opts: CompetitorPatternRunOptions): Promise<void> {
  if (!opts.lead) {
    console.error('Provide --lead <lead-id>.');
    process.exitCode = 1;
    return;
  }
  const lead = await ctx.leads.getById(opts.lead);
  if (!lead) {
    console.error(`Lead not found: ${opts.lead}`);
    process.exitCode = 1;
    return;
  }
  if (opts.apply && !ctx.config.COMPETITOR_PATTERN_ENABLED) {
    console.error('Refusing to persist: COMPETITOR_PATTERN_ENABLED=false. Persisted generation requires the flag = true.');
    process.exitCode = 1;
    return;
  }
  const resolved = await resolvePatternInput(ctx, opts.lead, opts);
  if ('error' in resolved) {
    console.error(resolved.error);
    process.exitCode = 1;
    return;
  }

  const service = new CompetitorPatternService({ uow: new DrizzleCompetitorPatternUnitOfWork(ctx.db) });
  const res = await service.run(resolved.input, opts.apply === true);
  const pkg = res.package;

  console.log(`\nCompetitor pattern ${opts.apply ? 'APPLY' : 'DRY REPORT'} — lead ${lead.id}`);
  console.log(`  research run: ${resolved.researchRunId}  capture run: ${resolved.captureRunId}`);
  console.log(`  package confidence: ${pkg.confidence}  eligible evidence: ${String(pkg.eligibleEvidenceCount)}  excluded: ${String(pkg.excludedEvidenceCount)}`);
  console.log(`  packageHash: ${pkg.packageHash.slice(0, 12)}  inputHash: ${pkg.inputHash.slice(0, 12)}`);

  const positive = pkg.patterns.filter((p) => (p.result === 'ALL_OBSERVED' || p.result === 'MAJORITY_OBSERVED') && !p.isDepth);
  console.log(`\n  Positive presence patterns (${String(positive.length)}):`);
  if (positive.length === 0) console.log('    (none)');
  for (const p of positive) {
    console.log(`    [${p.confidence}] ${p.category}: ${String(p.presentCount)}/${String(p.usableDenominator)} → ${p.result}  wording="${p.wordingText ?? ''}"`);
  }

  console.log(`\n  Prospect contrasts (${String(pkg.contrasts.length)}):`);
  if (pkg.contrasts.length === 0) console.log('    (none)');
  for (const c of pkg.contrasts) console.log(`    ${c.category} — prospect ABSENT (${c.confidence}) → ${c.consequenceLabel}`);

  if (!res.validation.ok) {
    console.log('\n  Validation errors (package cannot be approved):');
    for (const e of res.validation.errors) console.log(`    ✗ ${e}`);
  } else {
    console.log('\n  Validation: OK (no prohibited claims; source-traceable).');
  }

  if (opts.apply) {
    if (res.reusedExisting) {
      console.log(`\n  Idempotent: identical package already persisted as ${res.packageRecordId ?? ''} (v${String(res.version)}). No duplicate created.`);
    } else if (res.persisted) {
      console.log(`\n  Persisted DRAFT package ${res.packageRecordId ?? ''} (v${String(res.version)}). Prior DRAFT packages superseded (not deleted). Approval is a separate explicit step.`);
    }
  } else {
    console.log('\n  Dry report — no database writes. No email composed, no AI call, no Gmail/Sheets access, no sending.');
  }
}
