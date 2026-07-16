import { getCampaign } from '../../config/campaigns.js';
import { DEMO_TEMPLATE_ID, DEMO_TEMPLATE_VERSION } from '../../domain/demo/demo-types.js';
import { DemoService } from '../../domain/demo/demo-service.js';
import { LocalDemoWriter } from '../../integrations/demo/demo-writer.js';
import { generateDemos, type DemoItem } from '../../pipeline/generate-demos.js';
import { DrizzleDemoUnitOfWork } from '../../persistence/demo-unit-of-work.js';
import { DemoInputRepository } from '../../persistence/repositories/demo-input.repo.js';
import { LeadFactsRepository } from '../../persistence/repositories/lead-facts.repo.js';
import { PipelineRunsRepository } from '../../persistence/repositories/runs.repo.js';
import { type CliContext } from '../context.js';

export interface GenerateDemosOptions {
  campaign: string;
  limit?: string;
}

export async function generateDemosCommand(ctx: CliContext, cliOpts: GenerateDemosOptions): Promise<void> {
  const campaign = getCampaign(cliOpts.campaign);
  const c = ctx.config;

  if (!c.DEMO_GENERATION_ENABLED) {
    console.log('Demo generation is disabled (DEMO_GENERATION_ENABLED=false).');
    return;
  }

  const service = new DemoService({
    uow: new DrizzleDemoUnitOfWork(ctx.db),
    writer: new LocalDemoWriter(c.DEMO_OUTPUT_DIR),
    logger: ctx.logger,
    config: {
      minOpportunityForDemo: c.MIN_OPPORTUNITY_FOR_DEMO,
      templateId: DEMO_TEMPLATE_ID,
      templateVersion: DEMO_TEMPLATE_VERSION,
    },
  });

  const inputRepo = new DemoInputRepository(ctx.db);
  const factsRepo = new LeadFactsRepository(ctx.db);

  const all = await ctx.leads.list(1000);
  let leads = all.filter((l) => l.status === 'OPPORTUNITY_READY');
  if (cliOpts.limit) leads = leads.slice(0, Number.parseInt(cliOpts.limit, 10));
  leads = leads.slice(0, c.MAX_BRANDED_DEMOS_PER_RUN);

  const items: DemoItem[] = [];
  let skippedNoAudit = 0;
  for (const lead of leads) {
    const audit = await inputRepo.latestAudit(lead.id);
    if (!audit) {
      skippedNoAudit += 1;
      ctx.logger.warn({ leadId: lead.id }, 'OPPORTUNITY_READY lead has no AUDITED run — skipped');
      continue;
    }
    const facts = await factsRepo.listCurrentFacts(lead.id);
    items.push({ input: { leadId: lead.id, facts, opportunityScore: audit.opportunityScore, findings: audit.findings } });
  }

  const runs = new PipelineRunsRepository(ctx.db);
  const runId = await runs.start(`demos:${campaign.name}`, c.DRY_RUN);
  const summary = await generateDemos({ service, logger: ctx.logger }, items, { runId });
  await runs.finish(runId, 'COMPLETED', JSON.stringify({ ...summary, paths: summary.paths.length }));

  console.log(`\nDemo run ${runId} (${campaign.name}):`);
  console.log(`  leads:                    ${items.length}${skippedNoAudit > 0 ? ` (+${skippedNoAudit} skipped: no audit)` : ''}`);
  console.log(`  DEMO_BUILT:               ${summary.DEMO_BUILT}`);
  console.log(`  NO_DEMO_NOT_JUSTIFIED:    ${summary.NO_DEMO_NOT_JUSTIFIED}`);
  console.log(`  NO_DEMO_INSUFFICIENT:     ${summary.NO_DEMO_INSUFFICIENT_FACTS}`);
  console.log(`  VALIDATION_FAILED:        ${summary.VALIDATION_FAILED}`);
  console.log(`  DEMO_BUILD_FAILED:        ${summary.DEMO_BUILD_FAILED}`);
  if (summary.failed > 0) console.log(`  failed (internal):        ${summary.failed}`);
  if (summary.paths.length > 0) {
    console.log('\n  Generated demos (local, pending human review — not published):');
    for (const p of summary.paths) console.log(`    ${p}`);
    console.log('\n  Preview one with:  pnpm cli preview-demo --lead <lead-id>');
  }
}
