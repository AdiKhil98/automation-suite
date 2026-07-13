import { getCampaign } from '../../config/campaigns.js';
import { enrichLeads, type EnrichBatchItem } from '../../pipeline/enrich-leads.js';
import { LeadFactsRepository } from '../../persistence/repositories/lead-facts.repo.js';
import { PipelineRunsRepository } from '../../persistence/repositories/runs.repo.js';
import { buildEnrichmentService } from './enrichment-build.js';
import { type CliContext } from '../context.js';

export interface EnrichLeadsCliOptions {
  campaign: string;
  limit?: string;
}

export async function enrichLeadsCommand(ctx: CliContext, cliOpts: EnrichLeadsCliOptions): Promise<void> {
  const campaign = getCampaign(cliOpts.campaign);
  const factsRepo = new LeadFactsRepository(ctx.db);

  const all = await ctx.leads.list(1000);
  let ready = all.filter((l) => l.status === 'READY_FOR_ENRICHMENT');
  if (cliOpts.limit) ready = ready.slice(0, Number.parseInt(cliOpts.limit, 10));
  ready = ready.slice(0, ctx.config.MAX_ENRICHMENTS_PER_RUN);

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
  const { service, verify, budget } = buildEnrichmentService(ctx);

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
