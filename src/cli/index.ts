import { Command } from 'commander';
import { collectLeadsCommand } from './commands/collect-leads.js';
import { enrichLeadCommand } from './commands/enrich-lead.js';
import { enrichLeadsCommand } from './commands/enrich-leads.js';
import { qualifyLeadsCommand } from './commands/qualify-leads.js';
import { createSampleLeads } from './commands/create-sample-leads.js';
import { leadState } from './commands/lead-state.js';
import { listLeads } from './commands/list-leads.js';
import { resetTestData } from './commands/reset-test-data.js';
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
  .command('reset-test-data')
  .description('Clear all local pipeline data (blocked when NODE_ENV=production)')
  .action(() => withContext(resetTestData));

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);

  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
