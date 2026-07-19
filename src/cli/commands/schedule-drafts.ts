import { type ScheduleOutcome } from '../../domain/schedule/schedule-service.js';
import { ScheduleInputRepository } from '../../persistence/repositories/schedule-input.repo.js';
import { PipelineRunsRepository } from '../../persistence/repositories/runs.repo.js';
import { buildScheduleService, schedulingRules } from './schedule-build.js';
import { type CliContext } from '../context.js';

export interface ScheduleDraftsOptions {
  limit?: string;
  dryRun?: boolean;
  notBefore?: string;
}

export async function scheduleDraftsCommand(ctx: CliContext, cliOpts: ScheduleDraftsOptions): Promise<void> {
  const c = ctx.config;
  const dryRun = !!cliOpts.dryRun;
  if (!c.SCHEDULING_ENABLED && !dryRun) {
    console.log('Scheduling is disabled (SCHEDULING_ENABLED=false). Use --dry-run to preview without changes.');
    return;
  }
  const service = buildScheduleService(ctx);
  const inputRepo = new ScheduleInputRepository(ctx.db);
  const notBeforeMs = cliOpts.notBefore ? Date.parse(cliOpts.notBefore) : undefined;
  if (cliOpts.notBefore && Number.isNaN(notBeforeMs)) { console.log(`Invalid --not-before value: ${cliOpts.notBefore}`); return; }

  const all = await ctx.leads.list(1000);
  let leads = all.filter((l) => l.status === 'DRAFT_CREATED');
  if (cliOpts.limit) leads = leads.slice(0, Number.parseInt(cliOpts.limit, 10));

  console.log(`\nSchedule run (dry-run=${String(dryRun)}):`);
  console.log(`  eligible DRAFT_CREATED leads: ${leads.length}`);
  console.log(`  rules: ${JSON.stringify(schedulingRules(c))}`);
  console.log('  Scheduling records intended send times only — it NEVER sends or calls Gmail.\n');

  // Dry-run performs no DB writes, so it uses no pipeline run id.
  const runId = dryRun ? '' : await new PipelineRunsRepository(ctx.db).start('schedule:drafts', c.DRY_RUN);
  const counts = new Map<ScheduleOutcome, number>();
  for (const lead of leads) {
    const data = await inputRepo.latest(lead.id);
    const r = await service.schedule({ leadId: lead.id, leadStatus: lead.status, gmailDraft: data.gmailDraft, finalizedContentHash: data.finalizedContentHash, recipientEmail: data.recipientEmail, timezone: data.timezone }, runId, { notBeforeMs: notBeforeMs, dryRun });
    counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
    if (r.scheduledAtUtc) console.log(`  ${lead.id}: ${r.outcome} → ${r.scheduledAtUtc}  |  ${r.scheduledAtLocal ?? ''}`);
    else console.log(`  ${lead.id}: ${r.outcome}${r.reason ? ` (${r.reason})` : ''}`);
  }
  if (!dryRun) await new PipelineRunsRepository(ctx.db).finish(runId, 'COMPLETED', JSON.stringify(Object.fromEntries(counts)));

  console.log('\nSummary:');
  for (const [outcome, n] of counts) console.log(`  ${outcome.padEnd(20)} ${String(n)}`);
}
