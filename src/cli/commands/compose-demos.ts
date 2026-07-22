import { getCampaign } from '../../config/campaigns.js';
import { extractDemoFacts } from '../../domain/demo/fact-extraction.js';
import { worstCaseComposerInputTokens } from '../../domain/demo/composer/composer-token-budget.js';
import { worstCaseCostUsd } from '../../integrations/llm/pricing.js';
import { composeDemos, type ComposeItem } from '../../pipeline/compose-demos.js';
import { AuditInputRepository } from '../../persistence/repositories/audit-input.repo.js';
import { DemoInputRepository } from '../../persistence/repositories/demo-input.repo.js';
import { LeadFactsRepository } from '../../persistence/repositories/lead-facts.repo.js';
import { PipelineRunsRepository } from '../../persistence/repositories/runs.repo.js';
import { buildComposerService } from './composer-build.js';
import { type CliContext } from '../context.js';

export interface ComposeDemosOptions {
  campaign: string;
  limit?: string;
  lead?: string;
}

export async function composeDemosCommand(ctx: CliContext, cliOpts: ComposeDemosOptions): Promise<void> {
  const campaign = getCampaign(cliOpts.campaign);
  const c = ctx.config;

  if (!c.DEMO_COMPOSER_ENABLED) {
    console.log('AI Demo Composer is disabled (DEMO_COMPOSER_ENABLED=false). Enable it to run compose-demos.');
    return;
  }

  const { service, providerName } = buildComposerService(ctx);
  const inputRepo = new DemoInputRepository(ctx.db);
  const captureRepo = new AuditInputRepository(ctx.db);
  const factsRepo = new LeadFactsRepository(ctx.db);

  // Projected worst-case cost for this run (before spending anything). For the mock
  // provider this is $0; for a real provider it bounds each demo at maxCostUsdPerDemo.
  const perCallGen = worstCaseCostUsd(c.DEMO_COMPOSER_MODEL, worstCaseComposerInputTokens(), c.DEMO_COMPOSER_MAX_OUTPUT_TOKENS);
  const perCallRev = worstCaseCostUsd(c.DEMO_COMPOSER_REVIEWER_MODEL, worstCaseComposerInputTokens(), c.DEMO_COMPOSER_MAX_OUTPUT_TOKENS);
  const perDemoWorstCase = providerName === 'mock' ? 0 : (perCallGen ?? 0) + (perCallRev ?? 0);

  const all = await ctx.leads.list(1000);
  let leads = all.filter((l) => l.status === 'OPPORTUNITY_READY' && (!cliOpts.lead || l.id === cliOpts.lead));
  if (cliOpts.limit) leads = leads.slice(0, Number.parseInt(cliOpts.limit, 10));
  leads = leads.slice(0, c.MAX_BRANDED_DEMOS_PER_RUN);

  const items: ComposeItem[] = [];
  let skippedNoAudit = 0;
  let enrichedFacts = 0;
  for (const lead of leads) {
    const audit = await inputRepo.latestAuditForComposer(lead.id);
    if (!audit) {
      skippedNoAudit += 1;
      ctx.logger.warn({ leadId: lead.id }, 'OPPORTUNITY_READY lead has no AUDITED run — skipped');
      continue;
    }

    // Same enrichment as generate-demos: extract additional demo facts from the verified
    // capture evidence and persist any missing ones as sourced 'website' facts (provenance).
    const capture = await captureRepo.latestAuditCapture(lead.id);
    if (capture) {
      const existing = new Set((await factsRepo.listCurrentFacts(lead.id)).map((f) => f.factType));
      const candidates = extractDemoFacts(capture.evidence).filter((cf) => !existing.has(cf.factType));
      if (candidates.length > 0) {
        await ctx.db.transaction(async (tx) => {
          const fr = new LeadFactsRepository(tx);
          for (const cf of candidates) {
            await fr.writeCurrentFact({ leadId: lead.id, factType: cf.factType, value: cf.value, normalizedValue: cf.normalizedValue, sourceType: 'website', sourceUrl: cf.sourceUrl, confidence: 0.9 });
            enrichedFacts += 1;
          }
        });
      }
    }

    const facts = await factsRepo.listCurrentFacts(lead.id);
    items.push({ input: { leadId: lead.id, facts, opportunityScore: audit.opportunityScore, findings: audit.findings } });
  }

  console.log(`\nCompose run (${campaign.name}, provider=${providerName}):`);
  console.log(`  eligible leads:             ${items.length}${skippedNoAudit > 0 ? ` (+${skippedNoAudit} skipped: no audit)` : ''}`);
  console.log(`  projected max cost / demo:  $${perDemoWorstCase.toFixed(4)} (cap $${c.DEMO_COMPOSER_MAX_COST_USD_PER_DEMO.toFixed(2)})`);
  console.log(`  projected max cost / run:   $${(perDemoWorstCase * items.length).toFixed(4)}`);

  const runs = new PipelineRunsRepository(ctx.db);
  const runId = await runs.start(`compose:${campaign.name}`, c.DRY_RUN);
  const summary = await composeDemos({ service, logger: ctx.logger }, items, { runId });
  await runs.finish(runId, 'COMPLETED', JSON.stringify({ ...summary, paths: summary.paths.length }));

  console.log(`\nCompose run ${runId} complete:`);
  console.log(`  facts extracted (capture):  ${enrichedFacts}`);
  console.log(`  DEMO_COMPOSED:              ${summary.DEMO_COMPOSED}`);
  console.log(`  REVIEW_REJECTED:           ${summary.REVIEW_REJECTED}`);
  console.log(`  SPEC_INVALID:              ${summary.SPEC_INVALID}`);
  console.log(`  RENDER_INVALID:            ${summary.RENDER_INVALID}`);
  console.log(`  SCHEMA_INVALID:            ${summary.SCHEMA_INVALID}`);
  console.log(`  BUDGET_BLOCKED:            ${summary.BUDGET_BLOCKED}`);
  console.log(`  MODEL_REFUSAL:             ${summary.MODEL_REFUSAL}`);
  console.log(`  RATE_LIMITED:              ${summary.RATE_LIMITED}`);
  console.log(`  TRANSIENT_PROVIDER_ERROR:  ${summary.TRANSIENT_PROVIDER_ERROR}`);
  if (summary.failed > 0) console.log(`  failed (internal):         ${summary.failed}`);
  console.log(`  actual spend:              $${summary.totalCostUsd.toFixed(4)}`);
  if (summary.paths.length > 0) {
    console.log('\n  Composed demos (local, pending human review — not published):');
    for (const p of summary.paths) console.log(`    ${p}`);
    console.log('\n  Preview one with:  pnpm cli preview-demo --lead <lead-id>');
  }
}
