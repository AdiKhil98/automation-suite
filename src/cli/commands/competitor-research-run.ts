import { CompetitorResearchService } from '../../domain/competitor/research-service.js';
import { DrizzleCompetitorResearchUnitOfWork } from '../../persistence/competitor-research-unit-of-work.js';
import { PipelineRunsRepository } from '../../persistence/repositories/runs.repo.js';
import { type EvaluatedCandidate } from '../../domain/competitor/types.js';
import { type CliContext } from '../context.js';
import { buildSelectionConfig, loadCompetitorSource, resolveProspectProfile } from './competitor-research-build.js';

export interface CompetitorResearchRunOptions {
  lead?: string;
  provider?: string;
  csv?: string;
  fixture?: string;
  apply?: boolean;
}

function printCandidate(c: EvaluatedCandidate): void {
  const score = c.comparabilityScore === null ? '—' : String(c.comparabilityScore);
  const tag = c.disposition === 'ACCEPTED' ? `ACCEPTED #${String(c.acceptanceRank)}` : `REJECTED ${c.rejectionReason ?? ''}`;
  console.log(`    [row ${String(c.input.rowIndex)}] ${c.normalizedDomain ?? c.input.website ?? '(no domain)'} — score ${score} — ${tag}`);
  console.log(`        ${c.reasonDetail}`);
}

/**
 * Evaluate one prospect's competitor candidates deterministically. Defaults to a DRY REPORT
 * (zero database writes). With --apply, persists an immutable DRAFT run + candidates (idempotent),
 * which additionally requires COMPETITOR_RESEARCH_ENABLED=true. Never captures websites, calls a
 * live provider/AI, sends, or touches Gmail/Sheets.
 */
export async function competitorResearchRunCommand(ctx: CliContext, opts: CompetitorResearchRunOptions): Promise<void> {
  if (!opts.lead) {
    console.error('Provide --lead <lead-id>.');
    process.exitCode = 1;
    return;
  }
  const apply = opts.apply === true;
  if (apply && !ctx.config.COMPETITOR_RESEARCH_ENABLED) {
    console.error('Refusing to persist: COMPETITOR_RESEARCH_ENABLED=false. Set it to true to apply, or omit --apply for a dry report.');
    process.exitCode = 1;
    return;
  }

  const lead = await ctx.leads.getById(opts.lead);
  if (!lead) {
    console.error(`Lead not found: ${opts.lead}`);
    process.exitCode = 1;
    return;
  }

  const provider = opts.provider ?? ctx.config.COMPETITOR_RESEARCH_PROVIDER;
  const cfg = buildSelectionConfig(ctx.config);
  let loaded;
  try {
    loaded = await loadCompetitorSource({
      provider,
      leadId: lead.id,
      csvPath: opts.csv,
      fixturePath: opts.fixture,
      maxInputCandidates: ctx.config.COMPETITOR_MAX_INPUT_CANDIDATES,
    });
  } catch (err) {
    console.error(`Run failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const { result } = loaded;
  if (!result.prospect) {
    console.error(`Cannot run: no prospect profile in source. ${result.errors.join('; ')}`);
    process.exitCode = 1;
    return;
  }
  if (result.errors.length > 0) {
    for (const e of result.errors) console.error(`  source warning: ${e}`);
  }

  const profile = resolveProspectProfile(result.prospect, lead);
  const service = new CompetitorResearchService(new DrizzleCompetitorResearchUnitOfWork(ctx.db));

  let runId: string | null = null;
  if (apply) {
    const runs = new PipelineRunsRepository(ctx.db);
    runId = await runs.start('competitor-research:apply', ctx.config.DRY_RUN);
  }

  const res = await service.run(profile, result.candidates, { provider: loaded.provider, apply, runId, config: cfg });

  console.log(`\nCompetitor research ${apply ? 'APPLY' : 'DRY REPORT'} — lead ${lead.id}`);
  console.log(`  provider: ${loaded.provider}  activeRadius: ${res.selection.activeRadius}  outcome: ${res.selection.outcome}`);
  console.log(`  candidates: ${String(res.selection.candidates.length)}  accepted(selected): ${String(res.selection.acceptedCount)}  rejected: ${String(res.selection.rejectedCount)}`);
  console.log(`  inputHash: ${res.inputHash.slice(0, 12)}  configHash: ${res.configHash.slice(0, 12)}`);

  console.log('\n  Selected competitors:');
  if (res.selection.selected.length === 0) console.log('    (none)');
  for (const c of res.selection.selected) printCandidate(c);

  console.log('\n  Rejected candidates:');
  const rejected = res.selection.candidates.filter((c) => c.disposition === 'REJECTED');
  if (rejected.length === 0) console.log('    (none)');
  for (const c of rejected) printCandidate(c);

  if (apply) {
    if (res.reusedExisting) {
      console.log(`\n  Idempotent: identical input already persisted as run ${res.runRecordId ?? ''} (v${String(res.version)}). No duplicate created.`);
    } else if (res.persisted) {
      console.log(`\n  Persisted DRAFT run ${res.runRecordId ?? ''} (v${String(res.version)}). Prior DRAFT runs for this lead were superseded (not deleted).`);
    }
  } else {
    console.log('\n  Dry report — no database writes were performed.');
  }
}
