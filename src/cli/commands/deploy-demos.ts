import { join } from 'node:path';
import { safePathSegment } from '../../domain/demo/sanitize.js';
import { type DeployOutcome } from '../../domain/deploy/deployment-service.js';
import { DeployInputRepository } from '../../persistence/repositories/deploy-input.repo.js';
import { PipelineRunsRepository } from '../../persistence/repositories/runs.repo.js';
import { buildDeploymentService } from './deploy-build.js';
import { type CliContext } from '../context.js';

export interface DeployDemosOptions {
  limit?: string;
  lead?: string;
  controlledTestRunId?: string;
}

export async function deployDemosCommand(ctx: CliContext, cliOpts: DeployDemosOptions): Promise<void> {
  const c = ctx.config;
  if (!c.NETLIFY_DEPLOYMENT_ENABLED) {
    console.log('Netlify deployment is disabled (NETLIFY_DEPLOYMENT_ENABLED=false).');
    return;
  }
  const { service, providerName, live } = buildDeploymentService(ctx);
  const inputRepo = new DeployInputRepository(ctx.db);

  const all = await ctx.leads.list(1000);
  let leads = all.filter((l) => l.status === 'WAITING_FOR_DEMO_URL' && (!cliOpts.lead || l.id === cliOpts.lead));
  const cap = c.NETLIFY_MAX_DEPLOYMENTS_PER_RUN;
  if (cliOpts.limit) leads = leads.slice(0, Number.parseInt(cliOpts.limit, 10));
  leads = leads.slice(0, cap);

  console.log(`\nDeploy run (provider=${providerName}, live=${String(live)}):`);
  console.log(`  eligible WAITING_FOR_DEMO_URL leads: ${leads.length} (per-run cap ${String(cap)})`);
  if (!live) console.log('  NOTE: mock provider — no real Netlify deployment.');

  const runs = new PipelineRunsRepository(ctx.db);
  const runId = await runs.start('deploy:netlify', c.DRY_RUN);
  const counts = new Map<DeployOutcome, number>();
  for (const lead of leads) {
    const data = await inputRepo.latest(lead.id);
    const demoDir = join(c.DEMO_OUTPUT_DIR, safePathSegment(lead.id));
    if (!data.demo) { ctx.logger.warn({ leadId: lead.id }, 'no demo for lead — skipped'); continue; }
    const controlled = cliOpts.controlledTestRunId
      ? await inputRepo.controlledEligibility(cliOpts.controlledTestRunId, lead.id, data)
      : null;
    const r = await service.deploy({ leadId: lead.id, leadStatus: lead.status, demoDir,
      demo: controlled?.demo ?? data.demo, email: controlled?.email ?? data.email }, runId);
    counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
  }
  await runs.finish(runId, 'COMPLETED', JSON.stringify(Object.fromEntries(counts)));

  console.log(`\nDeploy run ${runId} complete:`);
  for (const [outcome, n] of counts) console.log(`  ${outcome.padEnd(24)} ${String(n)}`);
  console.log('\n  Verified deploys create a URL-resolved finalized email that needs a SECOND human approval.');
  console.log('  No emails are sent and no Gmail drafts are created in Phase 11.');
}
