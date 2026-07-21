import { getCampaign } from '../../config/campaigns.js';
import { worstCaseEmailInputTokens } from '../../domain/email/email-token-budget.js';
import { worstCaseCostUsd } from '../../integrations/llm/pricing.js';
import { generateEmails, type EmailItem } from '../../pipeline/generate-emails.js';
import { DemoInputRepository } from '../../persistence/repositories/demo-input.repo.js';
import { EmailInputRepository } from '../../persistence/repositories/email-input.repo.js';
import { LeadFactsRepository } from '../../persistence/repositories/lead-facts.repo.js';
import { PipelineRunsRepository } from '../../persistence/repositories/runs.repo.js';
import { buildEmailService } from './email-build.js';
import { type CliContext } from '../context.js';

export interface GenerateEmailsOptions {
  campaign: string;
  limit?: string;
  lead?: string;
}

export async function generateEmailsCommand(ctx: CliContext, cliOpts: GenerateEmailsOptions): Promise<void> {
  const campaign = getCampaign(cliOpts.campaign);
  const c = ctx.config;

  if (!c.EMAIL_GENERATION_ENABLED) {
    console.log('Email generation is disabled (EMAIL_GENERATION_ENABLED=false).');
    return;
  }

  const { service, providerName } = buildEmailService(ctx);
  const auditRepo = new DemoInputRepository(ctx.db);
  const emailInputRepo = new EmailInputRepository(ctx.db);
  const factsRepo = new LeadFactsRepository(ctx.db);

  const perCallW = worstCaseCostUsd(c.EMAIL_WRITER_MODEL, worstCaseEmailInputTokens(), c.EMAIL_MAX_OUTPUT_TOKENS);
  const perCallR = worstCaseCostUsd(c.EMAIL_REVIEWER_MODEL, worstCaseEmailInputTokens(), c.EMAIL_MAX_OUTPUT_TOKENS);
  const perLeadWorstCase = providerName === 'mock' ? 0 : (perCallW ?? 0) + (perCallR ?? 0);

  const all = await ctx.leads.list(1000);
  let leads = all.filter((l) => (l.status === 'DEMO_READY' || l.status === 'DEMO_DECIDED') && (!cliOpts.lead || l.id === cliOpts.lead));
  if (cliOpts.limit) leads = leads.slice(0, Number.parseInt(cliOpts.limit, 10));

  const items: EmailItem[] = [];
  let skippedNoAudit = 0;
  for (const lead of leads) {
    const audit = await auditRepo.latestAuditForComposer(lead.id);
    if (!audit) { skippedNoAudit += 1; continue; }
    const facts = await factsRepo.listCurrentFacts(lead.id);
    const demo = await emailInputRepo.latestDemo(lead.id);
    items.push({ input: { leadId: lead.id, facts, findings: audit.findings, demo, opportunityScore: audit.opportunityScore } });
  }

  console.log(`\nEmail run (${campaign.name}, provider=${providerName}):`);
  console.log(`  eligible leads:            ${items.length}${skippedNoAudit > 0 ? ` (+${skippedNoAudit} skipped: no audit)` : ''}`);
  console.log(`  projected max cost / lead: $${perLeadWorstCase.toFixed(4)} (cap $${c.EMAIL_MAX_COST_USD_PER_LEAD.toFixed(2)})`);
  console.log(`  projected max cost / run:  $${(perLeadWorstCase * items.length).toFixed(4)}`);

  const runs = new PipelineRunsRepository(ctx.db);
  const runId = await runs.start(`emails:${campaign.name}`, c.DRY_RUN);
  const summary = await generateEmails({ service, logger: ctx.logger }, items, { runId });
  await runs.finish(runId, 'COMPLETED', JSON.stringify(summary));

  console.log(`\nEmail run ${runId} complete:`);
  console.log(`  APPROVED_READY:            ${summary.APPROVED_READY}`);
  console.log(`  APPROVED_WAITING_URL:      ${summary.APPROVED_WAITING_URL}`);
  console.log(`  REVIEW_REJECTED:           ${summary.REVIEW_REJECTED}`);
  console.log(`  VALIDATION_FAILED:         ${summary.VALIDATION_FAILED}`);
  console.log(`  SCHEMA_INVALID:            ${summary.SCHEMA_INVALID}`);
  console.log(`  BUDGET_BLOCKED:            ${summary.BUDGET_BLOCKED}`);
  console.log(`  MODEL_REFUSAL:             ${summary.MODEL_REFUSAL}`);
  console.log(`  RATE_LIMITED:              ${summary.RATE_LIMITED}`);
  console.log(`  TRANSIENT_PROVIDER_ERROR:  ${summary.TRANSIENT_PROVIDER_ERROR}`);
  if (summary.failed > 0) console.log(`  failed (internal):         ${summary.failed}`);
  console.log(`  actual spend:              $${summary.totalCostUsd.toFixed(4)}`);
  console.log('\n  Emails are drafts pending human review — never sent, no Gmail draft, no deployment.');
}
