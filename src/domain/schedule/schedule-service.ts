import { randomUUID } from 'node:crypto';
import { type Logger } from 'pino';
import { type LeadService, type LeadStore } from '../leads/lead-service.js';
import { type NewPipelineEvent } from '../pipeline/pipeline-event.js';
import { checkScheduleEligibility, type ScheduleEligibilitySnapshot } from './eligibility.js';
import { scheduleIntegrityFingerprint } from './fingerprint.js';
import { computeNextSlot, isSlotAllowed, type SchedulingRules } from './scheduler.js';
import { formatLocal } from './timezone.js';

export type ScheduleOutcome =
  | 'SCHEDULED'
  | 'SCHEDULED_DRYRUN'
  | 'DUPLICATE_REUSED'
  | 'INVALID_ELIGIBILITY'
  | 'TIMEZONE_INVALID'
  | 'SCHEDULE_BLOCKED'
  | 'CANCELLED'
  | 'NOT_SCHEDULED'
  | 'RESCHEDULED'
  | 'INVALID_SCHEDULE'
  | 'NOT_FOUND';

export interface ScheduleRecord {
  id: string;
  leadId: string;
  gmailDraftId: string;
  providerDraftId: string;
  finalizedContentHash: string;
  recipientEmail: string;
  scheduledAtUtc: Date;
  timezone: string;
  rulesVersion: string;
  computedFrom: unknown;
  integrityFingerprint: string;
  origin: string;
  status: 'SCHEDULED' | 'CANCELLED' | 'SUPERSEDED';
  supersededById: string | null;
  cancelReason: string | null;
  rescheduleCount: number;
}

export interface ScheduleConfig {
  featureEnabled: boolean;
  rules: SchedulingRules;
  rulesVersion: string;
}

export interface ScheduleInput {
  leadId: string;
  leadStatus: string;
  gmailDraft: { id: string; outcome: string; providerDraftId: string | null } | null;
  finalizedContentHash: string | null;
  recipientEmail: string | null;
  timezone: string | null;
}

export interface ScheduleStore {
  /** All active (SCHEDULED) scheduled instants, for account-wide spacing/cap. */
  activeScheduledUtc(): Promise<Date[]>;
  activeForDraft(gmailDraftId: string): Promise<ScheduleRecord | null>;
  activeForLead(leadId: string): Promise<ScheduleRecord | null>;
}
export interface ScheduleTxRepos {
  leads: LeadStore;
  leadService: LeadService;
  insert(row: ScheduleRecord): Promise<void>;
  supersede(oldId: string, newId: string, now: Date): Promise<void>;
  cancel(id: string, reason: string | null, now: Date): Promise<void>;
  events: { record(e: NewPipelineEvent): Promise<void> };
}
export interface ScheduleUnitOfWork {
  transaction<T>(fn: (repos: ScheduleTxRepos) => Promise<T>): Promise<T>;
}

export interface ScheduleServiceDeps {
  store: ScheduleStore;
  uow: ScheduleUnitOfWork;
  logger: Logger;
  config: ScheduleConfig;
  /** Injected clock for deterministic tests. */
  now?: () => number;
}

export interface ScheduleResultOut {
  leadId: string;
  outcome: ScheduleOutcome;
  scheduledAtUtc: string | null;
  scheduledAtLocal: string | null;
  reason?: string;
  rulesApplied?: SchedulingRules;
}

/**
 * Phase 13 scheduling. Records the intended send time for a created Gmail draft — NEVER sends,
 * never calls Gmail, never mutates the draft. Deterministic + fail-closed: requires a verified
 * recipient IANA timezone, binds the schedule to the draft/content/recipient (integrity
 * fingerprint), enforces one active schedule per draft, supersede-and-inserts on reschedule, and
 * preserves history on cancel. `--dry-run` computes + returns the slot with NO database writes.
 */
export class ScheduleService {
  private readonly now: () => number;
  constructor(private readonly deps: ScheduleServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  async schedule(input: ScheduleInput, runId: string, opts: { notBeforeMs?: number; dryRun?: boolean } = {}): Promise<ScheduleResultOut> {
    const c = this.deps.config;
    const active = input.gmailDraft ? await this.deps.store.activeForDraft(input.gmailDraft.id) : null;
    const snap: ScheduleEligibilitySnapshot = {
      leadStatus: input.leadStatus,
      gmailDraft: input.gmailDraft ? { outcome: input.gmailDraft.outcome, providerDraftId: input.gmailDraft.providerDraftId } : null,
      finalizedContentHash: input.finalizedContentHash,
      recipientEmail: input.recipientEmail,
      timezone: input.timezone,
      // A dry-run previews the slot even when the feature flag is off; it writes nothing.
      featureEnabled: c.featureEnabled || !!opts.dryRun,
      hasActiveSchedule: active !== null,
    };
    const elig = checkScheduleEligibility(snap);
    if (elig.duplicateReusable && active) return this.out(input.leadId, 'DUPLICATE_REUSED', active.scheduledAtUtc.getTime(), active.timezone, 'active_schedule_exists');
    if (!elig.eligible) {
      if (elig.timezoneProblem) return this.route(input, runId, 'TIMEZONE_INVALID', 'NEEDS_MANUAL_REVIEW', elig.reasons.join(','));
      return this.out(input.leadId, 'INVALID_ELIGIBILITY', null, null, elig.reasons.join(','));
    }

    const tz = input.timezone as string;
    const existing = (await this.deps.store.activeScheduledUtc()).map((d) => d.getTime());
    const slot = computeNextSlot({ nowMs: this.now(), tz, rules: c.rules, existingUtcMs: existing, notBeforeMs: opts.notBeforeMs });
    const atUtc = slot.scheduledAtUtc;
    if (!slot.ok || atUtc === undefined) return this.out(input.leadId, 'SCHEDULE_BLOCKED', null, null, 'no_slot_within_horizon');

    if (opts.dryRun) {
      return { leadId: input.leadId, outcome: 'SCHEDULED_DRYRUN', scheduledAtUtc: new Date(atUtc).toISOString(), scheduledAtLocal: formatLocal(tz, atUtc), rulesApplied: c.rules };
    }

    const draft = input.gmailDraft!;
    const record = this.buildRecord(input, draft, tz, atUtc, 'auto', 0);
    await this.deps.uow.transaction(async (repos) => {
      await repos.insert(record);
      const lead = await repos.leads.getById(input.leadId);
      if (lead && lead.status === 'DRAFT_CREATED') await repos.leadService.transition(input.leadId, 'SCHEDULED');
      await repos.events.record({ leadId: input.leadId, runId, type: 'NOTE', fromStatus: null, toStatus: null, message: 'schedule: SCHEDULED', data: { scheduledAtUtc: new Date(atUtc).toISOString(), timezone: tz } });
    });
    return this.out(input.leadId, 'SCHEDULED', atUtc, tz);
  }

  async cancel(leadId: string, reason: string | null, runId: string): Promise<ScheduleResultOut> {
    const active = await this.deps.store.activeForLead(leadId);
    if (!active) return this.out(leadId, 'NOT_SCHEDULED', null, null);
    await this.deps.uow.transaction(async (repos) => {
      await repos.cancel(active.id, reason, new Date());
      const lead = await repos.leads.getById(leadId);
      if (lead && lead.status === 'SCHEDULED') await repos.leadService.transition(leadId, 'DRAFT_CREATED');
      await repos.events.record({ leadId, runId, type: 'NOTE', fromStatus: null, toStatus: null, message: 'schedule: CANCELLED', data: { reason } });
    });
    return this.out(leadId, 'CANCELLED', active.scheduledAtUtc.getTime(), active.timezone);
  }

  async reschedule(input: ScheduleInput, atIso: string, runId: string): Promise<ScheduleResultOut> {
    const c = this.deps.config;
    const active = await this.deps.store.activeForLead(input.leadId);
    if (!active) return this.out(input.leadId, 'NOT_SCHEDULED', null, null);
    const atMs = Date.parse(atIso);
    if (Number.isNaN(atMs)) return this.out(input.leadId, 'INVALID_SCHEDULE', null, null, 'unparseable_time');

    const tz = active.timezone;
    const others = (await this.deps.store.activeScheduledUtc()).map((d) => d.getTime()).filter((t) => t !== active.scheduledAtUtc.getTime());
    const check = isSlotAllowed({ atMs, nowMs: this.now(), tz, rules: c.rules, otherActiveUtcMs: others });
    if (!check.ok) return this.out(input.leadId, 'INVALID_SCHEDULE', null, null, check.reason);

    // Supersede-and-insert: retain the old row (history), insert a new active schedule.
    const newRow = this.buildRecord(input, { id: active.gmailDraftId, providerDraftId: active.providerDraftId }, tz, atMs, 'manual', active.rescheduleCount + 1);
    await this.deps.uow.transaction(async (repos) => {
      // Supersede the old active row FIRST, then insert the new one — the partial-unique
      // "one active schedule per draft" index is enforced per-statement, so both must not be
      // SCHEDULED simultaneously.
      await repos.supersede(active.id, newRow.id, new Date());
      await repos.insert(newRow);
      await repos.events.record({ leadId: input.leadId, runId, type: 'NOTE', fromStatus: null, toStatus: null, message: 'schedule: RESCHEDULED', data: { from: active.scheduledAtUtc.toISOString(), to: new Date(atMs).toISOString() } });
    });
    return this.out(input.leadId, 'RESCHEDULED', atMs, tz);
  }

  private buildRecord(input: ScheduleInput, draft: { id: string; providerDraftId: string | null }, tz: string, atMs: number, origin: string, rescheduleCount: number): ScheduleRecord {
    const id = randomUUID();
    const providerDraftId = draft.providerDraftId ?? '';
    const finalizedContentHash = input.finalizedContentHash ?? '';
    const recipientEmail = input.recipientEmail ?? '';
    const fingerprint = scheduleIntegrityFingerprint({ leadId: input.leadId, gmailDraftId: draft.id, providerDraftId, finalizedContentHash, recipientEmail, scheduledAtUtcMs: atMs, rulesVersion: this.deps.config.rulesVersion });
    return {
      id, leadId: input.leadId, gmailDraftId: draft.id, providerDraftId, finalizedContentHash, recipientEmail,
      scheduledAtUtc: new Date(atMs), timezone: tz, rulesVersion: this.deps.config.rulesVersion, computedFrom: this.deps.config.rules,
      integrityFingerprint: fingerprint, origin, status: 'SCHEDULED', supersededById: null, cancelReason: null, rescheduleCount,
    };
  }

  private async route(input: ScheduleInput, runId: string, outcome: ScheduleOutcome, to: 'NEEDS_MANUAL_REVIEW', reason: string): Promise<ScheduleResultOut> {
    await this.deps.uow.transaction(async (repos) => {
      const lead = await repos.leads.getById(input.leadId);
      if (lead && lead.status === 'DRAFT_CREATED') await repos.leadService.transition(input.leadId, to);
      await repos.events.record({ leadId: input.leadId, runId, type: 'NOTE', fromStatus: null, toStatus: null, message: `schedule: ${outcome}`, data: { reason } });
    });
    return this.out(input.leadId, outcome, null, null, reason);
  }

  private out(leadId: string, outcome: ScheduleOutcome, atMs: number | null, tz: string | null, reason?: string): ScheduleResultOut {
    return { leadId, outcome, scheduledAtUtc: atMs === null ? null : new Date(atMs).toISOString(), scheduledAtLocal: atMs === null || tz === null ? null : formatLocal(tz, atMs), reason };
  }
}
