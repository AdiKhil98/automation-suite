import {
  authorizationInvalidReasons, isAuthorizationValid,
} from '../../domain/send/scheduled-send-authorization.js';
import {
  buildDailyLoads, computeCoverage, computeFollowupForecast,
  horizonDayKeys, isBlockedOutreachStatus, laneForSequenceStep, mergeKnownFollowupObligations,
  partitionBlockedInventory, placeFollowupsOnDays, PIPELINE_STATUSES, RAW_STATUSES,
  READY_UNSCHEDULED_STATUSES, resolveCapacity, REVIEW_QUEUE_STATUSES, SCHEDULED_STATUSES,
  STALLED_STATUSES, utcDayKey, type AuthorizationInput, type KnownObligationInput, type LeadBlockCheck,
  type OutreachRecordStateCount,
} from '../../domain/outreach/backlog-status.js';
import { LEAD_STATUSES, type LeadStatus } from '../../domain/leads/status.js';
import { BacklogStatusRepository } from '../../persistence/repositories/backlog-status.repo.js';
import { ScheduledSendAuthorizationRepository } from '../../persistence/repositories/scheduled-send.repo.js';
import { SuppressionRepository } from '../../persistence/repositories/suppression.repo.js';
import { type CliContext } from '../context.js';

export interface BacklogStatusOptions {
  dailyCap?: string;
  horizonDays?: string;
}

function countIn(byStatus: Map<string, number>, statuses: readonly LeadStatus[]): number {
  return statuses.reduce((sum, s) => sum + (byStatus.get(s) ?? 0), 0);
}

function fmtBreakdown(byStatus: Map<string, number>, statuses: readonly LeadStatus[]): string {
  return statuses.map((s) => `${s}=${String(byStatus.get(s) ?? 0)}`).join(' ');
}

/**
 * Read-only backlog / capacity report. No write, no send, no Gmail, no paid call. See
 * docs/AUTOMATION_PILOT.md for the production units this reads from.
 */
export async function backlogStatusCommand(ctx: CliContext, opts: BacklogStatusOptions): Promise<void> {
  const repo = new BacklogStatusRepository(ctx.db);
  const suppression = new SuppressionRepository(ctx.db);
  const authRepo = new ScheduledSendAuthorizationRepository(ctx.db);

  const now = new Date();
  const nowMs = now.getTime();

  let cliDailyCap: number | null = null;
  if (opts.dailyCap !== undefined) {
    const n = Number(opts.dailyCap);
    if (!Number.isInteger(n) || n <= 0) { console.log('--daily-cap must be a positive integer.'); return; }
    cliDailyCap = n;
  }
  const extraHorizon = opts.horizonDays !== undefined ? Number(opts.horizonDays) : null;
  if (opts.horizonDays !== undefined && (!Number.isInteger(extraHorizon) || (extraHorizon ?? 0) <= 0)) {
    console.log('--horizon-days must be a positive integer.'); return;
  }

  // --- Capacity source resolution (fix #1: --daily-cap is required; the durable authorization's
  // max_per_day is never substituted for it, only ever used to further tighten it). ---
  const gmailAccount = ctx.config.GMAIL_ACCOUNT_EMAIL?.trim().toLowerCase() ?? null;
  const policyVersion = ctx.config.SENDING_POLICY_VERSION;
  let authInput: AuthorizationInput | null = null;
  let authWarning: string | null = null;
  if (!gmailAccount) {
    authWarning = 'GMAIL_ACCOUNT_EMAIL is not configured — cannot check the durable scheduled-send authorization.';
  } else {
    const latest = await authRepo.latest(gmailAccount, policyVersion);
    if (!latest) {
      authWarning = `no scheduled-send authorization found for account=${gmailAccount} policy=${policyVersion}.`;
    } else {
      const usableNow = isAuthorizationValid(latest, nowMs, gmailAccount, policyVersion);
      authInput = { maxPerDay: latest.maxPerDay, usableNow };
      if (!usableNow) {
        const reasons = authorizationInvalidReasons(latest, nowMs, gmailAccount, policyVersion);
        authWarning = `latest authorization ${latest.id} is not currently usable (${reasons.join(', ')}).`;
      }
    }
  }
  const capacity = resolveCapacity(cliDailyCap, authInput);

  console.log('\nBacklog / capacity status (read-only; no writes, no sends, no Gmail, no paid calls)');
  console.log(`Generated at: ${now.toISOString()} (UTC)`);
  console.log(`\nDaily cap: ${capacity.effectiveCap ?? 'UNKNOWN'}`);
  console.log(`Capacity source: ${capacity.source}`);
  console.log(`Live sendability: ${capacity.sendability}`);
  if (authWarning) console.log(`Authorization note: ${authWarning}`);
  if (capacity.hypothetical) console.log('NOTE: capacity below is HYPOTHETICAL — not currently authorized to send.');

  // --- RAW / PIPELINE / STALLED ---
  const byStatus = await repo.countLeadsByStatus();
  const bucketed = new Set(LEAD_STATUSES);
  for (const s of byStatus.keys()) if (!bucketed.has(s as LeadStatus)) console.log(`WARNING: unrecognized lead status in DB: ${s}`);

  console.log(`\nRAW        (${String(countIn(byStatus, RAW_STATUSES))}): ${fmtBreakdown(byStatus, RAW_STATUSES)}`);
  console.log(`PIPELINE   (${String(countIn(byStatus, PIPELINE_STATUSES))}): ${fmtBreakdown(byStatus, PIPELINE_STATUSES)}`);
  console.log(`STALLED    (${String(countIn(byStatus, STALLED_STATUSES))}): ${fmtBreakdown(byStatus, STALLED_STATUSES)}  [excluded from all capacity math]`);

  // --- Sequence-lane disambiguation for the shared statuses (REVIEW_QUEUE / READY_UNSCHEDULED / SCHEDULED) ---
  const reviewIds = await repo.leadIdsWithStatus(REVIEW_QUEUE_STATUSES);
  const readyUnschedIds = await repo.leadIdsWithStatus(READY_UNSCHEDULED_STATUSES);
  const scheduledIdsRaw = await repo.leadIdsWithStatus(SCHEDULED_STATUSES);
  const sharedIds = [...new Set([...reviewIds, ...readyUnschedIds])];
  const stepByLead = await repo.latestDraftStepByLead(sharedIds);

  let initialReview = 0, followupReview = 0;
  for (const id of reviewIds) {
    if (laneForSequenceStep(stepByLead.get(id) ?? 0) === 'INITIAL') initialReview++; else followupReview++;
  }

  const readyUnschedInitialIds: string[] = [];
  const readyUnschedFollowupIds: string[] = [];
  for (const id of readyUnschedIds) {
    (laneForSequenceStep(stepByLead.get(id) ?? 0) === 'INITIAL' ? readyUnschedInitialIds : readyUnschedFollowupIds).push(id);
  }

  // --- Active scheduled sends: split initial vs follow-up by the driving draft's sequence step ---
  const activeScheduled = await repo.activeScheduledSends();
  const scheduledInitials = activeScheduled.filter((r) => r.sequenceStep === 0);
  const scheduledFollowups = activeScheduled.filter((r) => r.sequenceStep >= 1);
  // Sanity cross-check only (never used for arithmetic): leads.status='SCHEDULED' count should equal
  // scheduledInitials.length + scheduledFollowups.length in a consistent system.
  if (scheduledIdsRaw.length !== activeScheduled.length) {
    console.log(`WARNING: ${String(scheduledIdsRaw.length)} leads have status=SCHEDULED but ${String(activeScheduled.length)} active send_schedules rows were found — investigate before trusting SCHEDULED figures.`);
  }

  // --- Fix #4: authoritative blocked-inventory exclusion for READY_UNSCHEDULED(initial) + SCHEDULED_INITIALS ---
  const initialCandidateIds = [...new Set([...readyUnschedInitialIds, ...scheduledInitials.map((r) => r.leadId)])];
  const identities = await repo.leadIdentities(initialCandidateIds);
  const outreachRows = await repo.outreachRecordsForLeads(initialCandidateIds);
  const outreachBlockedByLead = new Map<string, boolean>();
  for (const r of outreachRows) {
    const blocked = r.status !== null && isBlockedOutreachStatus(r.status, r.doNotContact);
    if (blocked) outreachBlockedByLead.set(r.leadId, true);
  }
  // Per-lead isSuppressed() calls here are deliberate (spec option B): bounded strictly to the
  // small READY_UNSCHEDULED(initial) + SCHEDULED_INITIALS candidate set, never the full leads
  // table, so this stays cheap as the pipeline grows while reusing the exact authoritative check
  // (no weaker approximation, no suppression-semantics drift).
  const checks: LeadBlockCheck[] = [];
  for (const id of initialCandidateIds) {
    const identity = identities.get(id);
    const suppressed = identity ? await suppression.isSuppressed(identity) : false;
    checks.push({ leadId: id, suppressed, outreachBlocked: outreachBlockedByLead.get(id) ?? false });
  }
  const blocked = partitionBlockedInventory(checks);
  const readyUnscheduledCoverage = readyUnschedInitialIds.filter((id) => !blocked.blockedLeadIds.has(id)).length;
  const scheduledInitialsCoverage = scheduledInitials.filter((r) => !blocked.blockedLeadIds.has(r.leadId)).length;

  console.log(`\nINITIAL_REVIEW_QUEUE:  ${String(initialReview)}`);
  console.log(`FOLLOWUP_REVIEW_QUEUE: ${String(followupReview)}`);
  console.log(`\nREADY_UNSCHEDULED (initial):        ${String(readyUnschedInitialIds.length)}  (usable for coverage: ${String(readyUnscheduledCoverage)})`);
  console.log(`READY_UNSCHEDULED (follow-up, info): ${String(readyUnschedFollowupIds.length)}`);
  console.log(`SCHEDULED_INITIALS:  ${String(scheduledInitials.length)}  (usable for coverage: ${String(scheduledInitialsCoverage)})`);
  console.log(`SCHEDULED_FOLLOWUPS: ${String(scheduledFollowups.length)}`);
  console.log(`BLOCKED_ACTIVE_INVENTORY: ${String(blocked.blockedCount)}  (suppressed=${String(blocked.suppressedCount)}, outreach-blocked=${String(blocked.outreachBlockedCount)})  [excluded from the coverage figures above]`);

  // --- Known vs projected follow-ups (fix #2 dedupe by (outreach_record_id, sequence_step)) ---
  const dueRows = await repo.dueFollowups();
  const obligationInputs: KnownObligationInput[] = [
    ...dueRows.map((r) => ({ outreachRecordId: r.outreachRecordId, step: r.step, dueAt: r.dueAt, scheduledAtUtc: null })),
    ...scheduledFollowups
      .filter((r): r is typeof r & { outreachRecordId: string } => r.outreachRecordId !== null)
      .map((r) => ({ outreachRecordId: r.outreachRecordId, step: r.sequenceStep, dueAt: null, scheduledAtUtc: r.scheduledAtUtc })),
  ];
  const merged = mergeKnownFollowupObligations(obligationInputs);
  const recordStateCounts: OutreachRecordStateCount[] = await repo.outreachRecordStateCounts();
  const forecast = computeFollowupForecast(recordStateCounts, merged.length);

  console.log(`\nKnown follow-up obligations (deduped by outreach_record_id+step): ${String(merged.length)}`);
  console.log(`  of which already dated (scheduled): ${String(merged.filter((m) => m.isDated).length)}`);
  console.log(`  of which due but not yet scheduled:  ${String(merged.filter((m) => !m.isDated).length)}`);
  console.log(`Projected additional follow-ups beyond known obligations (CONSERVATIVE MAX, NOT guaranteed sends,`);
  console.log(`  cannot be reliably bounded to a specific day from current sequence state): ${String(forecast.projectedMaxFollowups)}`);

  // --- Coverage: KNOWN vs CONSERVATIVE, for 7-day and 10-day (plus an optional extra horizon) ---
  const horizons = [7, 10, ...(extraHorizon && extraHorizon !== 7 && extraHorizon !== 10 ? [extraHorizon] : [])];
  for (const h of horizons) {
    const dayKeys = horizonDayKeys(nowMs, h);
    const followupCountsByDay = placeFollowupsOnDays(merged, dayKeys, nowMs);
    const scheduledInitialDayKeys = scheduledInitials.map((r) => utcDayKey(r.scheduledAtUtc.getTime()));
    const dailyLoads = buildDailyLoads(dayKeys, scheduledInitialDayKeys, followupCountsByDay);
    const coverage = computeCoverage({
      horizonDays: h, effectiveCap: capacity.effectiveCap, sendability: capacity.sendability,
      dailyLoads, readyUnscheduled: readyUnscheduledCoverage, projectedMaxFollowups: forecast.projectedMaxFollowups,
    });

    console.log(`\n${String(h)}-day window (UTC calendar days):`);
    if (coverage.effectiveCap === null) {
      console.log('  capacity UNKNOWN — deficit arithmetic skipped (pass --daily-cap).');
      continue;
    }
    console.log(`  KNOWN unfilled initial slots:        ${String(coverage.knownUnfilledSlots)}`);
    console.log(`  KNOWN deficit (vs ready-unscheduled): ${String(coverage.knownDeficit)}`);
    console.log(`  CONSERVATIVE unfilled slots (reserves ${String(forecast.projectedMaxFollowups)} for undated projected follow-ups, MAX/planning estimate only): ${String(coverage.conservativeUnfilledSlots)}`);
    console.log(`  CONSERVATIVE deficit:                 ${String(coverage.conservativeDeficit)}`);
  }

  console.log('\nDay bucketing: UTC calendar day (the scheduled sender\'s cap is UTC-based). Local/London time is not used for any arithmetic above.');
}
