import { CompetitorPatternService } from '../../domain/competitor/pattern-service.js';
import { DrizzleCompetitorPatternUnitOfWork } from '../../persistence/competitor-pattern-unit-of-work.js';
import { type CliContext } from '../context.js';
import { resolvePatternInput } from './competitor-pattern-build.js';

export interface CompetitorPatternPlanOptions {
  lead?: string;
  researchRun?: string;
  captureRun?: string;
}

/**
 * Phase 7A3A read-only plan: resolve the research run, active capture run, selected competitors,
 * prospect evidence, and category mappings; show the proposed pattern denominators and which
 * comparisons are withheld. Performs NO network request and NO database write. Composes no email.
 */
export async function competitorPatternPlanCommand(ctx: CliContext, opts: CompetitorPatternPlanOptions): Promise<void> {
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
  const resolved = await resolvePatternInput(ctx, opts.lead, opts);
  if ('error' in resolved) {
    console.error(resolved.error);
    process.exitCode = 1;
    return;
  }

  // build() is pure and writes nothing.
  const service = new CompetitorPatternService({ uow: new DrizzleCompetitorPatternUnitOfWork(ctx.db) });
  const { package: pkg, validation } = service.build(resolved.input);

  console.log(`\nCompetitor pattern PLAN (read-only) — lead ${lead.id}`);
  console.log(`  research run: ${resolved.researchRunId}  capture run: ${resolved.captureRunId}`);
  console.log(`  selected competitors (distinct brands counted): ${String(resolved.selectedCount)}`);
  console.log(`  eligible evidence: ${String(pkg.eligibleEvidenceCount)}  excluded: ${String(pkg.excludedEvidenceCount)}`);
  console.log(`  prospect capture: ${resolved.input.prospect.captureRunId ?? '(none — contrasts will be UNKNOWN)'}`);

  console.log('\n  Proposed pattern denominators (present/absent/unknown → result):');
  for (const p of pkg.patterns) {
    const tag = p.isDepth ? ' [depth — no prospect contrast]' : '';
    console.log(`    ${p.category}: ${String(p.presentCount)}/${String(p.absentCount)}/${String(p.unknownCount)} denom=${String(p.usableDenominator)} → ${p.result}${tag}`);
  }

  console.log('\n  Proposed prospect contrasts (mapped categories with verified prospect ABSENT):');
  if (pkg.contrasts.length === 0) console.log('    (none)');
  for (const c of pkg.contrasts) console.log(`    ${c.category} — prospect ABSENT (${c.confidence})`);

  if (!validation.ok) {
    console.log('\n  Validation (would BLOCK approval):');
    for (const e of validation.errors) console.log(`    ✗ ${e}`);
  }
  console.log('\n  No network request or database write was performed. No email was composed.');
}
