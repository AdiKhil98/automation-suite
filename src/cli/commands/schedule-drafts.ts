import { type ScheduleOutcome } from '../../domain/schedule/schedule-service.js';
import { ScheduleInputRepository } from '../../persistence/repositories/schedule-input.repo.js';
import { PipelineRunsRepository } from '../../persistence/repositories/runs.repo.js';
import { buildScheduleService, schedulingRules } from './schedule-build.js';
import { type CliContext } from '../context.js';

export interface ScheduleDraftsOptions {
  lead?: string;
  limit?: string;
  dryRun?: boolean;
  notBefore?: string;
}

/** The only lead properties the `--lead` scoping gate inspects. */
export interface ScopedLeadSnapshot {
  id: string;
  status: string;
}

export type ScopedTargetDecision<T> = { ok: true; lead: T } | { ok: false; reason: string };
export type ScopeGateResult = { ok: true } | { ok: false; reason: string };

/**
 * Fail-closed gate for `--lead`: the named lead must exist and be DRAFT_CREATED before a scoped
 * run may consider it. A `--lead` that cannot be used is always a refusal — it NEVER widens back
 * to the broad sweep. Scoping selects which lead is considered; it does not alter scheduling
 * policy, slot calculation, or eligibility (those remain owned by the schedule service).
 */
export function checkScopedTarget<T extends ScopedLeadSnapshot>(leadId: string, lead: T | null): ScopedTargetDecision<T> {
  if (!lead) return { ok: false, reason: `lead_not_found:${leadId}` };
  if (lead.status !== 'DRAFT_CREATED') return { ok: false, reason: `lead_not_draft_created:${lead.status}` };
  return { ok: true, lead };
}

/**
 * Fail-closed gate for `--lead`: the scoped lead must already have a created Gmail draft with a
 * provider id. This mirrors the draft half of `checkScheduleEligibility` so a scoped run refuses
 * loudly (non-zero exit) instead of reporting a quiet per-lead INVALID_ELIGIBILITY line.
 */
export function checkScopedDraft(gmailDraft: { outcome: string; providerDraftId: string | null } | null): ScopeGateResult {
  if (!gmailDraft) return { ok: false, reason: 'no_gmail_draft' };
  if (gmailDraft.outcome !== 'DRAFT_CREATED') return { ok: false, reason: `gmail_draft_not_created:${gmailDraft.outcome}` };
  if (!gmailDraft.providerDraftId) return { ok: false, reason: 'no_provider_draft_id' };
  return { ok: true };
}

/** Broad-sweep selection used when `--lead` is omitted (unchanged pre-existing behavior). */
export function selectSweepTargets<T extends ScopedLeadSnapshot>(all: T[], limit?: string): T[] {
  const eligible = all.filter((l) => l.status === 'DRAFT_CREATED');
  return limit === undefined ? eligible : eligible.slice(0, Number.parseInt(limit, 10));
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

  // `--lead` restricts the run to exactly one lead, fetched by id (never via the capped sweep
  // listing, so an older lead is still addressable). Every gate below fails closed.
  const scopedLeadId = cliOpts.lead?.trim();
  let leads: ScopedLeadSnapshot[];
  if (scopedLeadId) {
    const target = checkScopedTarget(scopedLeadId, await ctx.leads.getById(scopedLeadId));
    if (!target.ok) {
      console.error(`Scoped schedule REFUSED: ${target.reason}. No lead considered; nothing written.`);
      process.exitCode = 1;
      return;
    }
    const draft = checkScopedDraft((await inputRepo.latest(scopedLeadId)).gmailDraft);
    if (!draft.ok) {
      console.error(`Scoped schedule REFUSED: ${draft.reason}. No lead considered; nothing written.`);
      process.exitCode = 1;
      return;
    }
    leads = [target.lead];
  } else {
    leads = selectSweepTargets(await ctx.leads.list(1000), cliOpts.limit);
  }

  console.log(`\nSchedule run (dry-run=${String(dryRun)}):`);
  if (scopedLeadId) console.log(`  scope: EXACTLY ONE lead (${scopedLeadId}) — broad sweep disabled`);
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
