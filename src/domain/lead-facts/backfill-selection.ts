import { type Lead } from '../leads/lead.js';
import { type LeadStatus } from '../leads/status.js';
import { BACKFILL_FACT_TYPES, type BackfillFactType } from '../../persistence/google-place-details-store.js';

/**
 * Pure selection + planning logic for `places-backfill`. No IO, no API calls. The command layer
 * supplies leads and their current fact types; this decides who is eligible and what is missing.
 */

/**
 * Outreach-active and terminal states excluded from the DEFAULT backfill batch. Even though the
 * write is state-neutral, a lead with an email/draft/schedule already built from its facts should
 * not be swept in implicitly; it is reachable only via an explicit `--lead <id> --include-active`.
 */
export const BACKFILL_EXCLUDED_STATUSES: ReadonlySet<LeadStatus> = new Set<LeadStatus>([
  'EMAIL_DRAFTED',
  'EMAIL_REVIEW_FAILED',
  'EMAIL_APPROVED',
  'WAITING_FOR_DEMO_URL',
  'FINALIZED_EMAIL_PENDING',
  'READY_FOR_HUMAN_APPROVAL',
  'HUMAN_APPROVED',
  'DRAFT_CREATED',
  'SCHEDULED',
  'SENT',
  'REPLIED',
  'UNSUBSCRIBED',
  'BOUNCED',
  'FAILED',
]);

export function isExcludedOutreachStatus(status: LeadStatus): boolean {
  return BACKFILL_EXCLUDED_STATUSES.has(status);
}

/** The backfill fact types not currently present for a lead (subset of BACKFILL_FACT_TYPES). */
export function computeMissingBackfillFacts(currentFactTypes: ReadonlySet<string>): BackfillFactType[] {
  return BACKFILL_FACT_TYPES.filter((t) => !currentFactTypes.has(t));
}

export type SkipReason = 'no_place_id' | 'excluded_outreach_status' | 'lead_not_found';

export interface BackfillSelection {
  selected: Lead[];
  skipped: Array<{ leadId: string; reason: SkipReason }>;
}

export interface SelectOptions {
  /** Single-lead mode: exactly this id, fail-closed. */
  lead?: string;
  /** Bounded batch size. Ignored in single-lead mode. */
  limit?: number;
  /** Explicit opt-in to include outreach-active/terminal leads. */
  includeActive: boolean;
}

/**
 * Select backfill candidates deterministically. A lead qualifies only if it has a placeId and
 * (unless includeActive) is not in an excluded outreach status. Selection does NOT consider which
 * facts are missing — that is computed per-lead by the caller after loading current facts.
 */
export function selectBackfillTargets(leads: readonly Lead[], opts: SelectOptions): BackfillSelection {
  const skipped: BackfillSelection['skipped'] = [];

  if (opts.lead !== undefined) {
    const lead = leads.find((l) => l.id === opts.lead);
    if (!lead) return { selected: [], skipped: [{ leadId: opts.lead, reason: 'lead_not_found' }] };
    if (!lead.placeId) return { selected: [], skipped: [{ leadId: lead.id, reason: 'no_place_id' }] };
    if (!opts.includeActive && isExcludedOutreachStatus(lead.status)) {
      return { selected: [], skipped: [{ leadId: lead.id, reason: 'excluded_outreach_status' }] };
    }
    return { selected: [lead], skipped: [] };
  }

  const ordered = [...leads].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
  const selected: Lead[] = [];
  for (const lead of ordered) {
    if (!lead.placeId) {
      skipped.push({ leadId: lead.id, reason: 'no_place_id' });
      continue;
    }
    if (!opts.includeActive && isExcludedOutreachStatus(lead.status)) {
      skipped.push({ leadId: lead.id, reason: 'excluded_outreach_status' });
      continue;
    }
    selected.push(lead);
    if (opts.limit !== undefined && selected.length >= opts.limit) break;
  }
  return { selected, skipped };
}
