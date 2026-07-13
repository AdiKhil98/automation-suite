import { getCampaign } from '../../config/campaigns.js';
import { QUALIFICATION_RULES } from '../../config/qualification-rules.js';
import { QualificationService } from '../../domain/qualification/qualification-service.js';
import { qualifyLeads } from '../../pipeline/qualify-leads.js';
import { LeadFactsRepository } from '../../persistence/repositories/lead-facts.repo.js';
import { QualificationResultsRepository } from '../../persistence/repositories/qualification.repo.js';
import { SuppressionRepository } from '../../persistence/repositories/suppression.repo.js';
import { type CliContext } from '../context.js';

export interface QualifyLeadsCliOptions {
  campaign: string;
  limit?: string;
}

export async function qualifyLeadsCommand(
  ctx: CliContext,
  cliOpts: QualifyLeadsCliOptions,
): Promise<void> {
  const campaign = getCampaign(cliOpts.campaign);

  const service = new QualificationService({
    leads: ctx.leads,
    leadService: ctx.service,
    facts: new LeadFactsRepository(ctx.db),
    results: new QualificationResultsRepository(ctx.db),
    suppression: new SuppressionRepository(ctx.db),
  });

  const all = await ctx.leads.list(1000);
  let leads = all.filter((l) => QualificationService.isQualifiable(l.status));
  if (cliOpts.limit) leads = leads.slice(0, Number.parseInt(cliOpts.limit, 10));

  const summary = await qualifyLeads(
    { service, logger: ctx.logger },
    { campaign: campaign.name, niche: campaign.niche, rules: QUALIFICATION_RULES, leads },
  );

  console.log(`\nQualification run (${campaign.name}, rules ${QUALIFICATION_RULES.version}):`);
  console.log(`  evaluated:        ${summary.evaluated}`);
  console.log(`  ACCEPT:           ${summary.accepted}  (audit ${summary.audit}, website-discovery ${summary.websiteDiscovery})`);
  console.log(`  REVIEW:           ${summary.review}  (needs-enrichment ${summary.needsEnrichment}, manual-review ${summary.manualReview})`);
  console.log(`  REJECT:           ${summary.rejected}`);
  if (summary.failed > 0) console.log(`  failed:           ${summary.failed}`);
}
