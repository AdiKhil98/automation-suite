import { truncateAll } from '../../persistence/maintenance.js';
import { type CliContext } from '../context.js';

/**
 * Clear all local pipeline data. Refuses to run when NODE_ENV=production so the
 * command can never wipe a production database by accident.
 */
export async function resetTestData(ctx: CliContext): Promise<void> {
  if (ctx.config.NODE_ENV === 'production') {
    console.error('Refusing to reset data: NODE_ENV=production.');
    process.exitCode = 1;
    return;
  }
  await truncateAll(ctx.db);

  console.log('Local test data cleared (leads, evidence, pipeline_runs, pipeline_events).');
}
