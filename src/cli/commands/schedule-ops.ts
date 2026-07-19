import { eq } from 'drizzle-orm';
import { formatLocal } from '../../domain/schedule/timezone.js';
import { ScheduleInputRepository } from '../../persistence/repositories/schedule-input.repo.js';
import { PipelineRunsRepository } from '../../persistence/repositories/runs.repo.js';
import { leads as leadsTbl, sendSchedules } from '../../persistence/schema.js';
import { buildScheduleService } from './schedule-build.js';
import { type CliContext } from '../context.js';

/** Read-only view of active schedules (never sends). Shows UTC + recipient-local time and which
 * would be due now. */
export async function scheduleStatusCommand(ctx: CliContext): Promise<void> {
  const rows = await ctx.db.select({ s: sendSchedules, name: leadsTbl.businessName })
    .from(sendSchedules).innerJoin(leadsTbl, eq(leadsTbl.id, sendSchedules.leadId))
    .where(eq(sendSchedules.status, 'SCHEDULED')).orderBy(sendSchedules.scheduledAtUtc);
  console.log(`\nActive schedules: ${rows.length} (read-only — no sending in Phase 13)\n`);
  const now = Date.now();
  for (const { s, name } of rows) {
    const at = s.scheduledAtUtc.getTime();
    console.log(`  ${name ?? '(unnamed)'} [lead ${s.leadId}]`);
    console.log(`    UTC:   ${s.scheduledAtUtc.toISOString()}${at <= now ? '  <-- DUE (Phase 14 would act)' : ''}`);
    console.log(`    local: ${formatLocal(s.timezone, at)}   origin=${s.origin} reschedules=${String(s.rescheduleCount)}`);
  }
}

export async function cancelScheduleCommand(ctx: CliContext, opts: { lead: string; reason?: string }): Promise<void> {
  if (!ctx.config.SCHEDULING_ENABLED) { console.log('Scheduling is disabled (SCHEDULING_ENABLED=false).'); return; }
  const service = buildScheduleService(ctx);
  const runId = await new PipelineRunsRepository(ctx.db).start('schedule:cancel', ctx.config.DRY_RUN);
  const r = await service.cancel(opts.lead, opts.reason ?? null, runId);
  await new PipelineRunsRepository(ctx.db).finish(runId, 'COMPLETED', r.outcome);
  console.log(`\ncancel-schedule: ${r.outcome}${r.reason ? ` (${r.reason})` : ''} for lead ${opts.lead}`);
}

export async function rescheduleCommand(ctx: CliContext, opts: { lead: string; at: string }): Promise<void> {
  if (!ctx.config.SCHEDULING_ENABLED) { console.log('Scheduling is disabled (SCHEDULING_ENABLED=false).'); return; }
  const service = buildScheduleService(ctx);
  const data = await new ScheduleInputRepository(ctx.db).latest(opts.lead);
  const runId = await new PipelineRunsRepository(ctx.db).start('schedule:reschedule', ctx.config.DRY_RUN);
  const r = await service.reschedule({ leadId: opts.lead, leadStatus: 'SCHEDULED', gmailDraft: data.gmailDraft, finalizedContentHash: data.finalizedContentHash, recipientEmail: data.recipientEmail, timezone: data.timezone }, opts.at, runId);
  await new PipelineRunsRepository(ctx.db).finish(runId, 'COMPLETED', r.outcome);
  if (r.scheduledAtUtc) console.log(`\nreschedule: ${r.outcome} → ${r.scheduledAtUtc}  |  ${r.scheduledAtLocal ?? ''}`);
  else console.log(`\nreschedule: ${r.outcome}${r.reason ? ` (${r.reason})` : ''}`);
}
