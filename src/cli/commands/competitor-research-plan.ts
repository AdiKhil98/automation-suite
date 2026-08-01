import { type CliContext } from '../context.js';
import { buildSelectionConfig, loadCompetitorSource, resolveProspectProfile } from './competitor-research-build.js';

export interface CompetitorResearchPlanOptions {
  lead?: string;
  provider?: string;
  csv?: string;
  fixture?: string;
}

/**
 * Read-only preview: validate the lead + candidate source, show counts and the deterministic
 * configuration. Performs NO database writes, NO scoring persistence, NO network.
 */
export async function competitorResearchPlanCommand(ctx: CliContext, opts: CompetitorResearchPlanOptions): Promise<void> {
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
    console.error(`Plan failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const { result } = loaded;
  console.log(`\nCompetitor research PLAN (read-only) — lead ${lead.id}`);
  console.log(`  module enabled: ${String(ctx.config.COMPETITOR_RESEARCH_ENABLED)} (apply/persist requires true)`);
  console.log(`  provider: ${loaded.provider}`);
  console.log(`  config: primary=${String(cfg.primaryRadiusKm)}km fallback=${String(cfg.fallbackRadiusKm)}km maxSelected=${String(cfg.maxSelected)}`);
  console.log(`  lead status: ${lead.status}  normalizedDomain: ${lead.normalizedDomain ?? '(none)'}`);
  console.log(`  prospect row present: ${String(result.prospect !== null)}`);
  console.log(`  input candidates: ${String(result.candidates.length)}`);
  if (result.prospect && lead.normalizedDomain) {
    const p = resolveProspectProfile(result.prospect, lead);
    console.log(`  prospect category: ${p.primaryCategory ?? '(none)'}  coords: ${p.latitude !== null && p.longitude !== null ? 'yes' : 'MISSING'}`);
  }
  if (result.errors.length > 0) {
    console.log('  source warnings/errors:');
    for (const e of result.errors) console.log(`    - ${e}`);
  }
  console.log('\nNo database writes were performed (plan is read-only). Use competitor-research-run to evaluate.');
}
