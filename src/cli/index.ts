import { Command } from 'commander';
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
  .command('reset-test-data')
  .description('Clear all local pipeline data (blocked when NODE_ENV=production)')
  .action(() => withContext(resetTestData));

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);

  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
