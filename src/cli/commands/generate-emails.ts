import { getCampaign } from '../../config/campaigns.js';
import { worstCaseEmailInputTokens } from '../../domain/email/email-token-budget.js';
import { worstCaseCostUsd } from '../../integrations/llm/pricing.js';
import { generateEmails, type EmailItem } from '../../pipeline/generate-emails.js';
import { DemoInputRepository } from '../../persistence/repositories/demo-input.repo.js';
import { EmailInputRepository } from '../../persistence/repositories/email-input.repo.js';
import { LeadFactsRepository } from '../../persistence/repositories/lead-facts.repo.js';
import { ContactResolutionRepository } from '../../persistence/repositories/contact-resolution.repo.js';
import { PipelineRunsRepository } from '../../persistence/repositories/runs.repo.js';
import { ControlledTestRepository } from '../../persistence/repositories/controlled-test.repo.js';
import { buildEmailService } from './email-build.js';
import { type CliContext } from '../context.js';

export interface GenerateEmailsOptions {
  campaign: string;
  limit?: string;
  lead?: string;
  controlledTestRunId?: string;
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
  const resolutionRepo = new ContactResolutionRepository(ctx.db);

  const perCallW = worstCaseCostUsd(c.EMAIL_WRITER_MODEL, worstCaseEmailInputTokens(), c.EMAIL_MAX_OUTPUT_TOKENS);
  const perCallR = worstCaseCostUsd(c.EMAIL_REVIEWER_MODEL, worstCaseEmailInputTokens(), c.EMAIL_MAX_OUTPUT_TOKENS);
  const perLeadWorstCase = providerName === 'mock' ? 0 : (perCallW ?? 0) + (perCallR ?? 0);

  // A bespoke demo is optional proof, not a required stage: OPPORTUNITY_READY leads (post-audit,
  // opportunity-scored, no demo) are eligible alongside the demo-bearing DEMO_* states. Demo-link
  // emails are still only possible when an APPROVED demo actually exists (demo=null → reply-only).
  const EMAIL_ELIGIBLE_STATUSES = new Set(['DEMO_READY', 'DEMO_DECIDED', 'OPPORTUNITY_READY']);
  const all = await ctx.leads.list(1000);
  let leads = all.filter((l) => EMAIL_ELIGIBLE_STATUSES.has(l.status) && (!cliOpts.lead || l.id === cliOpts.lead));
  if (cliOpts.limit) leads = leads.slice(0, Number.parseInt(cliOpts.limit, 10));

  const items: EmailItem[] = [];
  let skippedNoAudit = 0;
  let skippedNoContactEmail = 0;
  for (const lead of leads) {
    const audit = await auditRepo.latestAuditForComposer(lead.id);
    if (!audit) { skippedNoAudit += 1; continue; }
    const facts = await factsRepo.listCurrentFacts(lead.id);
    // This pipeline delivers via Gmail to an email address. A lead with only a contact_form_url is
    // NOT deliverable here — it stays for a future/manual written-outreach path, never entering the
    // send pipeline that cannot reach it. Require a usable current contact_email.
    const hasContactEmail = facts.some((f) => f.factType === 'contact_email' && f.isCurrent && f.value.trim() !== '');
    if (!hasContactEmail) { skippedNoContactEmail += 1; continue; }
    let demo = await emailInputRepo.latestDemo(lead.id);
    if (cliOpts.controlledTestRunId) {
      if (!demo?.contentHash) throw new Error('controlled_test_demo_hash_missing');
      const approved = await new ControlledTestRepository(ctx.db).isArtifactApproved({
        controlledTestRunId: cliOpts.controlledTestRunId, leadId: lead.id, artifactType: 'DEMO',
        artifactId: demo.id, artifactHash: demo.contentHash,
      });
      if (!approved) throw new Error('controlled_test_demo_approval_invalid');
      demo = { ...demo, status: 'APPROVED' };
    }
    // Recipient contract. A GENERIC_OFFICIAL resolution keeps the copy unaddressed; its absence is
    // treated the same way (identity unproven), so no lead can be greeted by name by default.
    const resolution = await resolutionRepo.getCurrent(lead.id);
    const recipient = resolution
      ? {
          contactType: resolution.resolutionType,
          email: resolution.recipientEmail,
          intendedDecisionMakers: resolution.intendedDecisionMakers.map((d) => ({ fullName: d.fullName, title: d.title })),
        }
      : null;
    items.push({ input: { leadId: lead.id, facts, findings: audit.findings, demo, opportunityScore: audit.opportunityScore, recipient } });
  }

  console.log(`\nEmail run (${campaign.name}, provider=${providerName}):`);
  const skipNotes = [
    skippedNoAudit > 0 ? `${String(skippedNoAudit)} no audit` : null,
    skippedNoContactEmail > 0 ? `${String(skippedNoContactEmail)} no contact_email` : null,
  ].filter((n): n is string => n !== null);
  console.log(`  eligible leads:            ${items.length}${skipNotes.length > 0 ? ` (skipped: ${skipNotes.join(', ')})` : ''}`);
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
