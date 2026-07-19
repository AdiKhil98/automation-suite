import { Command } from 'commander';
import { auditWebsitesCommand } from './commands/audit-websites.js';
import { captureWebsitesCommand } from './commands/capture-websites.js';
import { cleanAuditDebugCommand } from './commands/clean-audit-debug.js';
import { collectLeadsCommand } from './commands/collect-leads.js';
import { enrichLeadCommand } from './commands/enrich-lead.js';
import { enrichLeadsCommand } from './commands/enrich-leads.js';
import { evalAuditCommand } from './commands/eval-audit.js';
import { gateACheckCommand } from './commands/gate-a-check.js';
import { generateDemosCommand } from './commands/generate-demos.js';
import { composeDemosCommand } from './commands/compose-demos.js';
import { generateEmailsCommand } from './commands/generate-emails.js';
import { reviewDashboardCommand } from './commands/review-dashboard.js';
import { deployDemosCommand } from './commands/deploy-demos.js';
import { gmailAuthCommand } from './commands/gmail-auth.js';
import { createGmailDraftsCommand } from './commands/create-gmail-drafts.js';
import { scheduleDraftsCommand } from './commands/schedule-drafts.js';
import { cancelScheduleCommand, rescheduleCommand, scheduleStatusCommand } from './commands/schedule-ops.js';
import { previewDemoCommand } from './commands/preview-demo.js';
import { qualifyLeadsCommand } from './commands/qualify-leads.js';
import { createSampleLeads } from './commands/create-sample-leads.js';
import { leadState } from './commands/lead-state.js';
import { listLeads } from './commands/list-leads.js';
import { resetTestData } from './commands/reset-test-data.js';
import { resumeAuditCommand } from './commands/resume-audit.js';
import { withContext } from './context.js';

const program = new Command();

program
  .name('automation-suite')
  .description('Controlled AI Outreach Operating System — Phase 1 CLI')
  .version('0.1.0');

program
  .command('create-sample-leads')
  .description('Insert deterministic sample leads into the local database')
  .action(() => withContext(createSampleLeads));

program
  .command('list-leads')
  .description('List leads with their current state')
  .action(() => withContext(listLeads));

program
  .command('lead-state')
  .description('Show a lead current state and full event history')
  .argument('<id>', 'lead id')
  .action((id: string) => withContext((ctx) => leadState(ctx, id)));

program
  .command('collect-leads')
  .description('Collect and deduplicate leads for a campaign (mock by default)')
  .requiredOption('--campaign <name>', 'campaign name (see src/config/campaigns.ts)')
  .option('--source <provider>', 'override provider: mock | google_places')
  .option('--dry-run', 'force dry-run (no paid API calls)')
  .option('--limit <n>', 'max new leads this run (overrides MAX_LEADS_PER_RUN)')
  .action((opts: { campaign: string; source?: string; dryRun?: boolean; limit?: string }) =>
    withContext((ctx) =>
      collectLeadsCommand(ctx, {
        campaign: opts.campaign,
        source: opts.source === 'google_places' ? 'google_places' : opts.source === 'mock' ? 'mock' : undefined,
        dryRun: opts.dryRun,
        limit: opts.limit,
      }),
    ),
  );

program
  .command('qualify-leads')
  .description('Deterministically qualify (PRE_AUDIT) collected leads for a campaign')
  .requiredOption('--campaign <name>', 'campaign name (see src/config/campaigns.ts)')
  .option('--limit <n>', 'max leads to qualify this run')
  .action((opts: { campaign: string; limit?: string }) =>
    withContext((ctx) => qualifyLeadsCommand(ctx, { campaign: opts.campaign, limit: opts.limit })),
  );

program
  .command('enrich-leads')
  .description('Discover & verify official websites for READY_FOR_ENRICHMENT leads (mock by default)')
  .requiredOption('--campaign <name>', 'campaign name (see src/config/campaigns.ts)')
  .option('--limit <n>', 'max leads to enrich this run')
  .action((opts: { campaign: string; limit?: string }) =>
    withContext((ctx) => enrichLeadsCommand(ctx, { campaign: opts.campaign, limit: opts.limit })),
  );

program
  .command('enrich-lead')
  .description('Manually verify an operator-supplied candidate URL (no Google/paid API)')
  .option('--lead <id>', 'lead id')
  .option('--candidate <url>', 'candidate official website URL')
  .option('--csv <path>', 'CSV of leadId,candidateUrl rows')
  .action((opts: { lead?: string; candidate?: string; csv?: string }) =>
    withContext((ctx) => enrichLeadCommand(ctx, opts)),
  );

program
  .command('capture-websites')
  .description('Playwright capture of verified official websites (mock by default)')
  .requiredOption('--campaign <name>', 'campaign name (see src/config/campaigns.ts)')
  .option('--purpose <p>', 'audit | verification', 'audit')
  .option('--limit <n>', 'max leads to capture this run')
  .action((opts: { campaign: string; purpose?: string; limit?: string }) =>
    withContext((ctx) => captureWebsitesCommand(ctx, opts)),
  );

program
  .command('audit-websites')
  .description('AI website audit of READY_FOR_AUDIT leads (mock by default; paid calls hard-gated)')
  .requiredOption('--campaign <name>', 'campaign name (see src/config/campaigns.ts)')
  .option('--limit <n>', 'max leads to audit this run')
  .action((opts: { campaign: string; limit?: string }) =>
    withContext((ctx) => auditWebsitesCommand(ctx, opts)),
  );

program
  .command('eval-audit')
  .description('Run the audit model eval matrix on the fixture dataset (mock by default; Gate B when paid)')
  .option('--models <list>', 'comma-separated generator models')
  .option('--reviewers <list>', 'comma-separated reviewer models (default: same as --models)')
  .option('--cases <list>', 'comma-separated fixture case names (default: all)')
  .option('--max-calls <n>', 'hard cap on model calls for the whole matrix')
  .option('--out <dir>', 'report output directory', './eval-reports')
  .action((opts: { models?: string; reviewers?: string; cases?: string; maxCalls?: string; out?: string }) =>
    withContext((ctx) => evalAuditCommand(ctx, opts)),
  );

program
  .command('gate-a-check')
  .description('Print Gate A readiness (projected tokens/cost, caps, safety gates) — no OpenAI call')
  .option('--limit <n>', 'max READY_FOR_AUDIT leads to report')
  .action((opts: { limit?: string }) => withContext((ctx) => gateACheckCommand(ctx, opts)))
  ;

program
  .command('clean-audit-debug')
  .description('Remove audit validation-debug envelopes (expired by default; --all purges everything)')
  .option('--all', 'purge all debug records, not just expired')
  .action((opts: { all?: boolean }) => withContext((ctx) => cleanAuditDebugCommand(ctx, opts)))
  ;

program
  .command('resume-audit')
  .description('Replay paid-result recovery envelopes after a failed DB write (never calls the model)')
  .action(() => withContext(resumeAuditCommand));

program
  .command('generate-demos')
  .description('Generate local concept-demo sites for OPPORTUNITY_READY leads (no deploy, human review required)')
  .requiredOption('--campaign <name>', 'campaign name (see src/config/campaigns.ts)')
  .option('--limit <n>', 'max leads to generate demos for this run')
  .action((opts: { campaign: string; limit?: string }) => withContext((ctx) => generateDemosCommand(ctx, opts)));

program
  .command('compose-demos')
  .description('AI Demo Composer: design + render local concept demos for OPPORTUNITY_READY leads (mock by default; no deploy, human review required)')
  .requiredOption('--campaign <name>', 'campaign name (see src/config/campaigns.ts)')
  .option('--limit <n>', 'max leads to compose demos for this run')
  .action((opts: { campaign: string; limit?: string }) => withContext((ctx) => composeDemosCommand(ctx, opts)));

program
  .command('generate-emails')
  .description('Phase 9: write one factual cold email per DEMO_READY/DEMO_DECIDED lead (mock by default; independent reviewer; no sending, no Gmail, no deploy)')
  .requiredOption('--campaign <name>', 'campaign name (see src/config/campaigns.ts)')
  .option('--limit <n>', 'max leads to write emails for this run')
  .action((opts: { campaign: string; limit?: string }) => withContext((ctx) => generateEmailsCommand(ctx, opts)));

program
  .command('deploy-demos')
  .description('Phase 11: deploy approved demos to Netlify DRAFT deploys, verify, and finalize the email (mock by default; no send/Gmail)')
  .option('--limit <n>', 'max leads to deploy this run')
  .action((opts: { limit?: string }) => withContext((ctx) => deployDemosCommand(ctx, opts)));

program
  .command('gmail-auth')
  .description('One-time local OAuth setup for Gmail draft creation (scope gmail.compose only; loopback callback; stores refresh token 0600)')
  .action(() => withContext((ctx) => gmailAuthCommand(ctx)));

program
  .command('create-gmail-drafts')
  .description('Phase 12: create a Gmail DRAFT (never send) for HUMAN_APPROVED leads with an approved finalized email (mock by default)')
  .option('--limit <n>', 'max leads to draft this run')
  .action((opts: { limit?: string }) => withContext((ctx) => createGmailDraftsCommand(ctx, opts)));

program
  .command('schedule-drafts')
  .description('Phase 13: record deterministic, timezone-aware send times for DRAFT_CREATED leads (never sends). --dry-run previews with no changes.')
  .option('--limit <n>', 'max leads to schedule this run')
  .option('--dry-run', 'compute + display proposed slots without any database or external changes')
  .option('--not-before <iso>', 'do not schedule before this ISO instant')
  .action((opts: { limit?: string; dryRun?: boolean; notBefore?: string }) => withContext((ctx) => scheduleDraftsCommand(ctx, opts)));

program
  .command('schedule-status')
  .description('Phase 13: list active schedules (read-only; UTC + recipient-local; no sending)')
  .action(() => withContext((ctx) => scheduleStatusCommand(ctx)));

program
  .command('cancel-schedule')
  .description('Phase 13: cancel a lead\'s active schedule (SCHEDULED → DRAFT_CREATED; history preserved)')
  .requiredOption('--lead <id>', 'lead id')
  .option('--reason <text>', 'cancellation reason')
  .action((opts: { lead: string; reason?: string }) => withContext((ctx) => cancelScheduleCommand(ctx, opts)));

program
  .command('reschedule')
  .description('Phase 13: reschedule a lead (supersede-and-insert; history preserved)')
  .requiredOption('--lead <id>', 'lead id')
  .requiredOption('--at <iso>', 'new send time (ISO 8601)')
  .action((opts: { lead: string; at: string }) => withContext((ctx) => rescheduleCommand(ctx, opts)));

program
  .command('review-dashboard')
  .description('Start the local review dashboard (loopback only; approve/reject demos + emails; no auth, no sending, no deploy)')
  .action(() => withContext((ctx) => reviewDashboardCommand(ctx)));

program
  .command('preview-demo')
  .description("Serve a lead's generated demo locally (loopback only; never public)")
  .requiredOption('--lead <id>', 'lead id')
  .action((opts: { lead: string }) => withContext((ctx) => previewDemoCommand(ctx, opts)));

program
  .command('reset-test-data')
  .description('Clear all local pipeline data (blocked when NODE_ENV=production)')
  .action(() => withContext(resetTestData));

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);

  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
