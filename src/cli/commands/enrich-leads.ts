import { getCampaign } from '../../config/campaigns.js';
import { type Lead } from '../../domain/leads/lead.js';
import { enrichLeads, type EnrichBatchItem } from '../../pipeline/enrich-leads.js';
import { LeadFactsRepository } from '../../persistence/repositories/lead-facts.repo.js';
import { PipelineRunsRepository } from '../../persistence/repositories/runs.repo.js';
import { AppError } from '../../utils/errors.js';
import { buildEnrichmentService } from './enrichment-build.js';
import { type CliContext } from '../context.js';

export interface EnrichLeadsCliOptions {
  campaign: string;
  limit?: string;
  /** Enrich exactly one lead id; fail-closed, single-lead, no bulk fallback. */
  lead?: string;
}

/**
 * Pure selection of which leads a single enrichment run will process.
 *
 * `--lead <id>` (single-lead mode) is a fail-closed, exactly-one selection: the id
 * must exist and be READY_FOR_ENRICHMENT, and NOTHING else is ever selected (no
 * fallback to the global READY_FOR_ENRICHMENT queue, no limit expansion). This is
 * what guarantees a targeted enrichment can never touch any other lead.
 *
 * Without `--lead`, behaviour is the existing batch: all READY_FOR_ENRICHMENT
 * leads, bounded by `--limit` then `MAX_ENRICHMENTS_PER_RUN`.
 */
export function selectLeadsToEnrich(
  all: Lead[],
  opts: { lead?: string; limit?: number; maxPerRun: number },
): Lead[] {
  if (opts.lead != null && opts.lead !== '') {
    const target = all.find((l) => l.id === opts.lead);
    if (!target) {
      throw new AppError('LEAD_NOT_FOUND', `Lead ${opts.lead} not found; refusing to enrich.`);
    }
    if (target.status !== 'READY_FOR_ENRICHMENT') {
      throw new AppError(
        'NOT_ENRICHABLE',
        `Lead ${opts.lead} is ${target.status}, not READY_FOR_ENRICHMENT; refusing to enrich.`,
      );
    }
    // Exactly one lead. No bulk fallback, no limit expansion, no retry.
    return [target];
  }

  let ready = all.filter((l) => l.status === 'READY_FOR_ENRICHMENT');
  if (opts.limit != null) ready = ready.slice(0, opts.limit);
  return ready.slice(0, opts.maxPerRun);
}

export async function enrichLeadsCommand(ctx: CliContext, cliOpts: EnrichLeadsCliOptions): Promise<void> {
  const campaign = getCampaign(cliOpts.campaign);
  const factsRepo = new LeadFactsRepository(ctx.db);

  const all = await ctx.leads.list(1000);
  const ready = selectLeadsToEnrich(all, {
    lead: cliOpts.lead,
    limit: cliOpts.limit != null ? Number.parseInt(cliOpts.limit, 10) : undefined,
    maxPerRun: ctx.config.MAX_ENRICHMENTS_PER_RUN,
  });

  const items: EnrichBatchItem[] = [];
  for (const lead of ready) {
    items.push({
      input: {
        leadId: lead.id,
        placeId: lead.placeId,
        currentFacts: await factsRepo.listCurrentFacts(lead.id),
      },
    });
  }

  const runs = new PipelineRunsRepository(ctx.db);
  const runId = await runs.start(`enrich-leads:${campaign.name}`, ctx.config.DRY_RUN);
  const { service, verify, budget } = buildEnrichmentService(ctx, {
    nicheAllowedCategories: campaign.niche.allowedCategories,
  });

  const summary = await enrichLeads({ service, logger: ctx.logger }, items, { runId, verify });
  await runs.finish(runId, 'COMPLETED', JSON.stringify(summary));

  console.log(`\nEnrichment run ${runId} (${campaign.name}, context=${ctx.config.ENRICHMENT_CONTEXT_PROVIDER}, candidate=${ctx.config.ENRICHMENT_CANDIDATE_PROVIDER}):`);
  console.log(`  evaluated leads:     ${items.length}`);
  console.log(`  VERIFIED:            ${summary.VERIFIED}  (conflicts: ${summary.conflicts})`);
  console.log(`  AMBIGUOUS:           ${summary.AMBIGUOUS}`);
  console.log(`  NO_VERIFIED_CAND.:   ${summary.NO_VERIFIED_CANDIDATE}`);
  console.log(`  BROWSER_REQUIRED:    ${summary.BROWSER_REQUIRED}`);
  console.log(`  INSUFFICIENT_CONTEXT:${summary.INSUFFICIENT_CONTEXT}`);
  console.log(`  NO_CANDIDATE:        ${summary.NO_CANDIDATE}`);
  console.log(`  TRANSIENT_ERROR:     ${summary.TRANSIENT_ERROR}`);
  console.log(`  POLICY_BLOCKED:      ${summary.POLICY_BLOCKED}`);
  console.log(`  INVALID_INPUT:       ${summary.INVALID_INPUT}`);
  if (summary.failed > 0) console.log(`  failed (internal):   ${summary.failed}`);
  if (ctx.config.ENRICHMENT_CONTEXT_PROVIDER === 'google') {
    console.log(`  google reads:        ${budget.requests} (est $${budget.estimatedCostUsd.toFixed(4)})`);
  }
}
