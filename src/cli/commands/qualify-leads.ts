import { getCampaign } from '../../config/campaigns.js';
import { QUALIFICATION_RULES } from '../../config/qualification-rules.js';
import { type Lead } from '../../domain/leads/lead.js';
import { QualificationService } from '../../domain/qualification/qualification-service.js';
import { qualifyLeads } from '../../pipeline/qualify-leads.js';
import { DrizzleQualificationUnitOfWork } from '../../persistence/qualification-unit-of-work.js';
import { type CliContext } from '../context.js';

export interface QualifyLeadsCliOptions {
  campaign: string;
  limit?: string;
  lead?: string;
}

export function selectQualifiableLeads<T extends Pick<Lead, 'id' | 'status'>>(
  all: T[],
  options: Pick<QualifyLeadsCliOptions, 'lead' | 'limit'>,
): T[] {
  if (options.lead) {
    const selected = all.find((lead) => lead.id === options.lead);
    if (!selected) throw new Error('qualification_lead_not_found');
    if (!QualificationService.isQualifiable(selected.status)) {
      throw new Error(`qualification_lead_not_qualifiable:${selected.status}`);
    }
    return [selected];
  }

  let selected = all.filter((lead) => QualificationService.isQualifiable(lead.status));
  if (options.limit) selected = selected.slice(0, Number.parseInt(options.limit, 10));
  return selected;
}

export async function qualifyLeadsCommand(
  ctx: CliContext,
  cliOpts: QualifyLeadsCliOptions,
): Promise<void> {
  const campaign = getCampaign(cliOpts.campaign);

  const service = new QualificationService(new DrizzleQualificationUnitOfWork(ctx.db));

  const all = await ctx.leads.list(1000);
  const leads = selectQualifiableLeads(all, cliOpts);

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
