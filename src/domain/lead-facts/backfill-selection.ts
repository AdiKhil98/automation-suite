import { type FactType } from './lead-fact.js';
import { type Lead } from '../leads/lead.js';
import { type LeadStatus } from '../leads/status.js';
import { BACKFILL_FACT_TYPES, type BackfillFactType } from '../../persistence/google-place-details-store.js';

/**
 * Pure selection + planning logic for `places-backfill`. No IO, no API calls. The command layer
 * supplies leads, their current fact types, and the set of leads with durable enrichment evidence;
 * this decides who is eligible and what is missing.
 */

/**
 * Durable evidence that a lead already received Google Place Details enrichment: the presence of a
 * `google_places`-provenance IDENTITY fact. Deliberately EXCLUDES `google_place_id` (present from
 * discovery, not enrichment) and the three backfill targets `rating`/`review_count`/`phone` (so the
 * eligibility signal can never be made self-fulfilling by a prior backfill). Combined at query time
 * with the presence of an `enrichment_attempts` row.
 */
export const GOOGLE_PLACES_IDENTITY_FACT_TYPES: readonly FactType[] = [
  'business_name',
  'candidate_website_url',
  'formatted_address',
  'city',
  'country',
  'category',
  'business_status',
];

/**
 * Outreach-active states excluded from the backfill batch. Even though the write is state-neutral, a
 * lead with an email/draft/schedule already built from its facts should not be swept in implicitly.
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

/**
 * Terminal/dead pre-outreach states excluded even when enrichment evidence exists — spending a paid
 * read on a dead lead is pointless. Only enums that exist in the current LeadStatus model.
 */
export const BACKFILL_TERMINAL_STATUSES: ReadonlySet<LeadStatus> = new Set<LeadStatus>([
  'REJECTED',
  'REJECTED_AUTOMATICALLY',
  'DUPLICATE',
]);

export function isExcludedOutreachStatus(status: LeadStatus): boolean {
  return BACKFILL_EXCLUDED_STATUSES.has(status);
}

export function isTerminalStatus(status: LeadStatus): boolean {
  return BACKFILL_TERMINAL_STATUSES.has(status);
}

/** The backfill fact types not currently present for a lead (subset of BACKFILL_FACT_TYPES). */
export function computeMissingBackfillFacts(currentFactTypes: ReadonlySet<string>): BackfillFactType[] {
  return BACKFILL_FACT_TYPES.filter((t) => !currentFactTypes.has(t));
}

export type SkipReason =
  | 'no_place_id'
  | 'not_enriched'
  | 'excluded_outreach_status'
  | 'terminal_status'
  | 'lead_not_found';

export interface BackfillSelection {
  selected: Lead[];
  skipped: Array<{ leadId: string; reason: SkipReason }>;
}

export interface SelectOptions {
  /** Single-lead mode: exactly this id, fail-closed. */
  lead?: string;
  /** Bounded batch size. Ignored in single-lead mode. */
  limit?: number;
  /** Leads with durable enrichment evidence (enrichment_attempts row OR a google_places identity fact). */
  enrichedLeadIds: ReadonlySet<string>;
}

/**
 * Classify a single lead. Returns null when eligible, otherwise the skip reason. Order is fixed and
 * deterministic: placeId → enrichment evidence → active-outreach → terminal/dead. Active-outreach and
 * terminal sets are disjoint, so their relative order is immaterial.
 */
function ineligibleReason(lead: Lead, enrichedLeadIds: ReadonlySet<string>): SkipReason | null {
  if (!lead.placeId) return 'no_place_id';
  if (!enrichedLeadIds.has(lead.id)) return 'not_enriched';
  if (isExcludedOutreachStatus(lead.status)) return 'excluded_outreach_status';
  if (isTerminalStatus(lead.status)) return 'terminal_status';
  return null;
}

/**
 * Select backfill candidates deterministically. A lead qualifies only if it has a placeId, carries
 * durable enrichment evidence, and is neither outreach-active nor terminal/dead. `--lead` obeys the
 * exact same rules and fails closed. Which facts are missing is computed per-lead by the caller.
 */
export function selectBackfillTargets(leads: readonly Lead[], opts: SelectOptions): BackfillSelection {
  if (opts.lead !== undefined) {
    const lead = leads.find((l) => l.id === opts.lead);
    if (!lead) return { selected: [], skipped: [{ leadId: opts.lead, reason: 'lead_not_found' }] };
    const reason = ineligibleReason(lead, opts.enrichedLeadIds);
    return reason
      ? { selected: [], skipped: [{ leadId: lead.id, reason }] }
      : { selected: [lead], skipped: [] };
  }

  const ordered = [...leads].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
  const selected: Lead[] = [];
  const skipped: BackfillSelection['skipped'] = [];
  for (const lead of ordered) {
    const reason = ineligibleReason(lead, opts.enrichedLeadIds);
    if (reason) {
      skipped.push({ leadId: lead.id, reason });
      continue;
    }
    selected.push(lead);
    if (opts.limit !== undefined && selected.length >= opts.limit) break;
  }
  return { selected, skipped };
}
