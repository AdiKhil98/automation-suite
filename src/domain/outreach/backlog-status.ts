import { LEAD_STATUSES, type LeadStatus } from '../leads/status.js';
import { followupBlockedReason } from './followups.js';
import { FINAL_FOLLOWUP_STEP } from './sequence.js';
import { type OutreachStatus } from './status.js';

/**
 * Pure, DB-free arithmetic for the read-only `backlog-status` CLI report. Nothing here queries a
 * database, sends anything, or makes an external call — every function takes plain data and
 * returns plain data, so the report's bucketing and capacity math are unit-testable without
 * Postgres. The CLI command (`src/cli/commands/backlog-status.ts`) and the repository
 * (`src/persistence/repositories/backlog-status.repo.ts`) are the only I/O boundaries.
 */

// --- A. Lead-status bucket definitions ------------------------------------------------------

export const RAW_STATUSES: readonly LeadStatus[] = [
  'NEW', 'NORMALIZED', 'READY_FOR_QUALIFICATION', 'READY_FOR_ENRICHMENT', 'ENRICHED',
];

export const PIPELINE_STATUSES: readonly LeadStatus[] = [
  'QUALIFIED', 'READY_FOR_CAPTURE', 'CAPTURED', 'READY_FOR_AUDIT', 'AUDITED',
  'OUTREACH_READY_DETERMINISTIC', 'OPPORTUNITY_READY', 'COMPETITOR_RESEARCH_READY',
  'DEMO_DECIDED', 'DEMO_READY', 'EMAIL_DRAFTED', 'EMAIL_APPROVED', 'WAITING_FOR_DEMO_URL',
];

/** Shared between initial and follow-up: which bucket a lead belongs to depends on sequence step (see classifyReviewOrReady). */
export const REVIEW_QUEUE_STATUSES: readonly LeadStatus[] = ['READY_FOR_HUMAN_APPROVAL', 'FINALIZED_EMAIL_PENDING'];
export const READY_UNSCHEDULED_STATUSES: readonly LeadStatus[] = ['HUMAN_APPROVED', 'DRAFT_CREATED'];
export const SCHEDULED_STATUSES: readonly LeadStatus[] = ['SCHEDULED'];

export const STALLED_STATUSES: readonly LeadStatus[] = ['NEEDS_MANUAL_REVIEW', 'EMAIL_REVIEW_FAILED'];

export const TERMINAL_STATUSES: readonly LeadStatus[] = [
  'DUPLICATE', 'REJECTED_AUTOMATICALLY', 'REJECTED', 'SENT', 'REPLIED', 'UNSUBSCRIBED', 'BOUNCED', 'FAILED',
];

export type LeadBucket = 'RAW' | 'PIPELINE' | 'REVIEW_QUEUE' | 'READY_UNSCHEDULED' | 'SCHEDULED' | 'STALLED' | 'TERMINAL';

const BUCKET_BY_STATUS: ReadonlyMap<LeadStatus, LeadBucket> = new Map([
  ...RAW_STATUSES.map((s): [LeadStatus, LeadBucket] => [s, 'RAW']),
  ...PIPELINE_STATUSES.map((s): [LeadStatus, LeadBucket] => [s, 'PIPELINE']),
  ...REVIEW_QUEUE_STATUSES.map((s): [LeadStatus, LeadBucket] => [s, 'REVIEW_QUEUE']),
  ...READY_UNSCHEDULED_STATUSES.map((s): [LeadStatus, LeadBucket] => [s, 'READY_UNSCHEDULED']),
  ...SCHEDULED_STATUSES.map((s): [LeadStatus, LeadBucket] => [s, 'SCHEDULED']),
  ...STALLED_STATUSES.map((s): [LeadStatus, LeadBucket] => [s, 'STALLED']),
  ...TERMINAL_STATUSES.map((s): [LeadStatus, LeadBucket] => [s, 'TERMINAL']),
]);

/** Every LeadStatus maps to exactly one bucket — enforced by a unit test iterating LEAD_STATUSES. */
export function classifyLeadStatus(status: LeadStatus): LeadBucket {
  const bucket = BUCKET_BY_STATUS.get(status);
  if (!bucket) throw new Error(`unbucketed_lead_status:${status}`);
  return bucket;
}

/** Every status this module classifies — used by a unit test to assert full coverage of LEAD_STATUSES. */
export function allClassifiedStatuses(): readonly LeadStatus[] {
  return LEAD_STATUSES;
}

/** Shared statuses (REVIEW_QUEUE, READY_UNSCHEDULED, SCHEDULED) split by which sequence step is driving them. */
export type SequenceLane = 'INITIAL' | 'FOLLOWUP';

export function laneForSequenceStep(sequenceStep: number): SequenceLane {
  return sequenceStep === 0 ? 'INITIAL' : 'FOLLOWUP';
}

// --- B. Capacity: cap resolution -------------------------------------------------------------

export type CapacitySendability = 'AUTHORIZED' | 'NOT_CURRENTLY_AUTHORIZED' | 'UNKNOWN';

export interface CapacityResolution {
  /** null only when sendability is UNKNOWN (no --daily-cap given). */
  effectiveCap: number | null;
  sendability: CapacitySendability;
  /** True when effectiveCap is shown only because an authorization could not be confirmed usable. */
  hypothetical: boolean;
  source: string;
}

export interface AuthorizationInput {
  maxPerDay: number;
  /** Result of isAuthorizationValid(auth, now, account, policy) from scheduled-send-authorization.ts. */
  usableNow: boolean;
}

/**
 * `--daily-cap` is REQUIRED for any capacity/deficit arithmetic — the durable authorization's
 * `max_per_day` is never substituted for it (an authorization can exist for reasons unrelated to
 * the operator's current planning cap, and using it silently would let this report show numbers
 * the operator never actually asked to plan against). When both are present, the effective cap is
 * the tighter of the two, because sending can never exceed either limit.
 */
export function resolveCapacity(cliDailyCap: number | null, auth: AuthorizationInput | null): CapacityResolution {
  if (cliDailyCap === null) {
    return { effectiveCap: null, sendability: 'UNKNOWN', hypothetical: false, source: 'none: --daily-cap is required for capacity arithmetic' };
  }
  if (auth && auth.usableNow) {
    return {
      effectiveCap: Math.min(cliDailyCap, auth.maxPerDay),
      sendability: 'AUTHORIZED',
      hypothetical: false,
      source: `min(--daily-cap=${String(cliDailyCap)}, authorization max_per_day=${String(auth.maxPerDay)})`,
    };
  }
  return {
    effectiveCap: cliDailyCap,
    sendability: 'NOT_CURRENTLY_AUTHORIZED',
    hypothetical: true,
    source: `--daily-cap=${String(cliDailyCap)} only — NO usable scheduled-send authorization found; hypothetical capacity, not currently authorized to send`,
  };
}

// --- UTC day bucketing (fix #7) ---------------------------------------------------------------

/** YYYY-MM-DD in UTC — the send cap is UTC-based, so every day-bucket key is derived this way. */
export function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function utcDayStartMs(dayKey: string): number {
  return Date.parse(`${dayKey}T00:00:00.000Z`);
}

/** The list of UTC day keys [today, today+horizonDays). */
export function horizonDayKeys(nowMs: number, horizonDays: number): string[] {
  const start = utcDayStartMs(utcDayKey(nowMs));
  return Array.from({ length: horizonDays }, (_, i) => utcDayKey(start + i * 86_400_000));
}

// --- C. Known vs projected follow-up logic (fix #2) -------------------------------------------

/** completedSteps for a record currently in this status; remaining = FINAL_FOLLOWUP_STEP - completed. */
const COMPLETED_STEPS: Partial<Record<OutreachStatus, number>> = {
  INITIAL_SENT: 0,
  FOLLOW_UP_1_DUE: 0,
  FOLLOW_UP_1_SENT: 1,
  FOLLOW_UP_2_DUE: 1,
  FOLLOW_UP_2_SENT: 2,
  FOLLOW_UP_3_DUE: 2,
  FOLLOW_UP_3_SENT: 3,
};

/**
 * Deterministic remaining follow-up sends implied by an outreach_record's CURRENT status alone.
 * Statuses before the initial is confirmed sent (DRAFT_READY/AWAITING_APPROVAL/APPROVED_TO_SEND)
 * conservatively contribute 0 — the initial isn't confirmed yet, so assuming any follow-up from it
 * would not be deterministic. Blocked statuses (replies/bounce/unsub/DNC/meeting/closed) must be
 * filtered out by the caller via `isBlockedOutreachStatus` before this is summed.
 */
export function remainingFollowupSteps(status: OutreachStatus): number {
  const completed = COMPLETED_STEPS[status];
  return completed === undefined ? 0 : FINAL_FOLLOWUP_STEP - completed;
}

/** A record in this status (or marked do-not-contact) can never receive another follow-up. */
export function isBlockedOutreachStatus(status: OutreachStatus, doNotContact: boolean): boolean {
  return doNotContact || followupBlockedReason(status) !== null;
}

export interface KnownObligationInput {
  outreachRecordId: string;
  step: number;
  /** Present when an outreach_followups DUE row exists for this (record, step). */
  dueAt: Date | null;
  /** Present when an active SCHEDULED send_schedules row exists for this (record, step). */
  scheduledAtUtc: Date | null;
}

export interface MergedFollowupObligation {
  key: string;
  outreachRecordId: string;
  step: number;
  /** The scheduled date when one exists, else the due date — never both, never invented. */
  displayDate: Date;
  /** True when this obligation already occupies a dated send_schedules slot. */
  isDated: boolean;
}

/**
 * Merge outreach_followups DUE rows with active SCHEDULED follow-up rows by the unique key
 * (outreach_record_id, sequence_step), so the same obligation is never counted twice (fix #2). The
 * scheduled date is preferred for display whenever a schedule exists, per spec.
 */
export function mergeKnownFollowupObligations(rows: KnownObligationInput[]): MergedFollowupObligation[] {
  interface Acc { outreachRecordId: string; step: number; dueAt: Date | null; scheduledAtUtc: Date | null }
  const byKey = new Map<string, Acc>();
  for (const r of rows) {
    const key = `${r.outreachRecordId}:${String(r.step)}`;
    const existing = byKey.get(key) ?? { outreachRecordId: r.outreachRecordId, step: r.step, dueAt: null, scheduledAtUtc: null };
    byKey.set(key, {
      outreachRecordId: r.outreachRecordId,
      step: r.step,
      dueAt: existing.dueAt ?? r.dueAt,
      scheduledAtUtc: existing.scheduledAtUtc ?? r.scheduledAtUtc,
    });
  }
  const out: MergedFollowupObligation[] = [];
  for (const [key, v] of byKey) {
    const displayDate = v.scheduledAtUtc ?? v.dueAt;
    if (!displayDate) continue; // neither source supplied a date — cannot happen given callers, but stay defensive.
    out.push({ key, outreachRecordId: v.outreachRecordId, step: v.step, displayDate, isDated: v.scheduledAtUtc !== null });
  }
  return out;
}

/**
 * Places every known follow-up obligation on a UTC day: a scheduled one uses its scheduled date
 * as-is; a due-only one is clamped to `max(dueAt, now)` (an overdue-but-unscheduled follow-up
 * would consume a slot TODAY once processed). Obligations that land outside `dayKeys` are known
 * (they still count in KNOWN_FOLLOWUPS, section C) but do not consume capacity within this horizon.
 */
export function placeFollowupsOnDays(
  obligations: readonly MergedFollowupObligation[],
  dayKeys: readonly string[],
  nowMs: number,
): Map<string, number> {
  const days = new Set(dayKeys);
  const counts = new Map<string, number>();
  for (const o of obligations) {
    const day = utcDayKey(Math.max(o.displayDate.getTime(), nowMs));
    if (!days.has(day)) continue;
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return counts;
}

/** Builds one DailyDatedLoad per day in `dayKeys`, from scheduled-initial day keys and placed follow-up counts. */
export function buildDailyLoads(
  dayKeys: readonly string[],
  scheduledInitialDayKeys: readonly string[],
  followupCountsByDay: ReadonlyMap<string, number>,
): DailyDatedLoad[] {
  const initialsByDay = new Map<string, number>();
  for (const day of scheduledInitialDayKeys) initialsByDay.set(day, (initialsByDay.get(day) ?? 0) + 1);
  return dayKeys.map((day) => ({
    day,
    scheduledInitials: initialsByDay.get(day) ?? 0,
    followupsConsuming: followupCountsByDay.get(day) ?? 0,
  }));
}

// --- B/C combined: capacity views (fix #3) ------------------------------------------------------

export interface DailyDatedLoad {
  /** UTC day key (YYYY-MM-DD). */
  day: string;
  scheduledInitials: number;
  /** Dated follow-up load for this day: active SCHEDULED follow-ups + DUE-but-unscheduled follow-ups whose due_at falls on this day. */
  followupsConsuming: number;
}

export interface CoverageResult {
  horizonDays: number;
  effectiveCap: number | null;
  sendability: CapacitySendability;
  /** Sum over the horizon of max(0, cap - followupsConsuming(d) - scheduledInitials(d)). */
  knownUnfilledSlots: number;
  knownDeficit: number;
  /** knownUnfilledSlots reduced by the undated PROJECTED_MAX_FOLLOWUPS reserve (never day-placed). */
  conservativeUnfilledSlots: number;
  conservativeDeficit: number;
}

/**
 * KNOWN capacity/deficit: uses only actual dated obligations (scheduled initials, scheduled
 * follow-ups, and DUE-but-unscheduled follow-ups placed on their real due_at day). CONSERVATIVE
 * capacity/deficit additionally reserves capacity for PROJECTED_MAX_FOLLOWUPS — obligations that
 * are deterministic in kind but have no due_at or schedule at all yet, so they cannot be placed on
 * a specific day without inventing one. The full projected ceiling is reserved against the whole
 * horizon (not scaled down for a shorter window) and must be labelled a MAX, not a forecast of
 * exact timing.
 */
export function computeCoverage(input: {
  horizonDays: number;
  effectiveCap: number | null;
  sendability: CapacitySendability;
  dailyLoads: DailyDatedLoad[]; // must have exactly horizonDays entries
  readyUnscheduled: number;
  projectedMaxFollowups: number;
}): CoverageResult {
  if (input.effectiveCap === null) {
    return {
      horizonDays: input.horizonDays, effectiveCap: null, sendability: input.sendability,
      knownUnfilledSlots: 0, knownDeficit: 0, conservativeUnfilledSlots: 0, conservativeDeficit: 0,
    };
  }
  const cap = input.effectiveCap;
  const knownUnfilledSlots = input.dailyLoads.reduce(
    (sum, d) => sum + Math.max(0, cap - d.followupsConsuming - d.scheduledInitials), 0,
  );
  const knownDeficit = Math.max(0, knownUnfilledSlots - input.readyUnscheduled);
  const conservativeUnfilledSlots = Math.max(0, knownUnfilledSlots - input.projectedMaxFollowups);
  const conservativeDeficit = Math.max(0, conservativeUnfilledSlots - input.readyUnscheduled);
  return {
    horizonDays: input.horizonDays, effectiveCap: cap, sendability: input.sendability,
    knownUnfilledSlots, knownDeficit, conservativeUnfilledSlots, conservativeDeficit,
  };
}

// --- Follow-up forecast (KNOWN_FOLLOWUPS is the deduped merge from mergeKnownFollowupObligations) ---

export interface OutreachRecordStateCount {
  status: OutreachStatus | null;
  doNotContact: boolean;
  count: number;
}

export interface FollowupForecast {
  totalRemaining: number;
  knownFollowups: number;
  projectedMaxFollowups: number;
}

/**
 * TOTAL_REMAINING sums remainingFollowupSteps() over every non-blocked outreach_record. Subtracting
 * the deduped KNOWN_FOLLOWUPS count (fix #2) leaves only the demand not yet backed by any row —
 * printed as a clearly-labelled conservative ceiling, never as guaranteed future sends.
 */
export function computeFollowupForecast(
  recordStateCounts: readonly OutreachRecordStateCount[],
  knownFollowupsCount: number,
): FollowupForecast {
  let totalRemaining = 0;
  for (const r of recordStateCounts) {
    if (r.status === null || isBlockedOutreachStatus(r.status, r.doNotContact)) continue;
    totalRemaining += remainingFollowupSteps(r.status) * r.count;
  }
  return {
    totalRemaining,
    knownFollowups: knownFollowupsCount,
    projectedMaxFollowups: Math.max(0, totalRemaining - knownFollowupsCount),
  };
}

// --- D. Blocked-inventory exclusion (fix #4) ---------------------------------------------------

export interface LeadBlockCheck {
  leadId: string;
  /** SuppressionRepository.isSuppressed() result for this lead. */
  suppressed: boolean;
  /** True if ANY of the lead's outreach_records rows is in a blocked state (see isBlockedOutreachStatus). */
  outreachBlocked: boolean;
}

export interface BlockedInventoryResult {
  blockedLeadIds: ReadonlySet<string>;
  suppressedCount: number;
  outreachBlockedCount: number;
  blockedCount: number;
}

/**
 * READY_UNSCHEDULED and SCHEDULED_INITIALS must never count a lead that is suppressed, do-not-
 * contact, replied-terminal, bounced, or unsubscribed as usable inventory (fix #4). This partitions
 * a candidate set (already checked against the authoritative suppression + outreach-status logic)
 * into blocked vs usable, plus a reason breakdown for the BLOCKED_ACTIVE_INVENTORY diagnostic.
 */
export function partitionBlockedInventory(checks: readonly LeadBlockCheck[]): BlockedInventoryResult {
  const blockedLeadIds = new Set<string>();
  let suppressedCount = 0;
  let outreachBlockedCount = 0;
  for (const c of checks) {
    if (c.suppressed) suppressedCount += 1;
    if (c.outreachBlocked) outreachBlockedCount += 1;
    if (c.suppressed || c.outreachBlocked) blockedLeadIds.add(c.leadId);
  }
  return { blockedLeadIds, suppressedCount, outreachBlockedCount, blockedCount: blockedLeadIds.size };
}
