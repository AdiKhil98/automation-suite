import { type Lead } from '../leads/lead.js';
import { isLifecycleEligibleForContactWork } from '../leads/lead-lifecycle.js';
import { computeInputHash } from '../contact-enrichment/service.js';
import { type CandidatePerson, type ContactEnrichmentResult } from '../contact-enrichment/types.js';

/**
 * Pure eligibility + prioritization logic for `contact-resolve-batch`. No IO, no API calls — mirrors
 * `selectBackfillTargets` (src/domain/lead-facts/backfill-selection.ts): the command layer supplies
 * already-fetched leads/domains/candidates/history; this decides who is eligible, in what order, and
 * which cascade provider is next for each.
 */

export type ResolveCascadeProvider = 'instantly' | 'hunter';

/** Fixed cascade order. Apollo is deliberately never a member — its provider code stays in the repo
 * but is not invoked by this command (unavailable on the current Apollo plan). */
export const CASCADE_ORDER: readonly ResolveCascadeProvider[] = ['instantly', 'hunter'];

export type SkipReason =
  /** Never durably qualified: no STATE_TRANSITION to QUALIFIED exists in this lead's pipeline_events
   * history (see `PipelineRepository.leadsEverReachedStatus`). */
  | 'not_qualified'
  /**
   * Durably qualified at some point, but its CURRENT status no longer permits new contact work:
   * REJECTED / REJECTED_AUTOMATICALLY / DUPLICATE / UNSUBSCRIBED / REPLIED, or outreach already in
   * flight (EMAIL_DRAFTED through SENT). See `isLifecycleEligibleForContactWork`.
   */
  | 'rejected_or_active_outreach'
  | 'no_verified_domain'
  | 'no_known_candidates'
  | 'already_verified'
  | 'chain_exhausted';

export interface ResolveBatchTarget {
  lead: Lead;
  domain: string;
  candidates: CandidatePerson[];
  /** Cascade providers NOT yet resolved for this lead's current candidate set, in cascade order. */
  nextSteps: ResolveCascadeProvider[];
  maxOpportunityScore: number | null;
}

export type ClassifyResult = { eligible: true; target: ResolveBatchTarget } | { eligible: false; reason: SkipReason };

/**
 * Whether a cascade provider step is already resolved for the lead's CURRENT candidate set.
 *
 * `ContactEnrichmentService.run()`'s idempotency check (`findByInputHash`) short-circuits on ANY
 * existing row at the exact (lead, provider, mode, inputHash) — it does NOT discriminate by outcome, so
 * a `CAPPED` row is JUST AS STICKY as `VERIFIED`/`NOT_FOUND`/`ERROR`: calling `run()` again with the
 * same candidates always replays the cached row, never re-attempts, regardless of a bigger budget this
 * time. Since this resolver never force-refreshes automatically, "resolved" therefore means simply "a
 * row exists at this exact hash" — there is no outcome to special-case.
 *
 * For Hunter specifically, either its normal ENRICH row (whose own Step 4 already covers Domain Search
 * when reached) OR a standalone DOMAIN_SEARCH_ONLY row (the guarded bypass) existing resolves the step —
 * this is exactly why Diamond Smile's Hunter path reads as resolved despite a CAPPED ENRICH row: its
 * DOMAIN_SEARCH_ONLY canary separately exists (outcome NOT_FOUND).
 */
function isProviderStepResolved(rows: readonly ContactEnrichmentResult[], provider: ResolveCascadeProvider, domain: string, candidates: CandidatePerson[]): boolean {
  const enrichHash = computeInputHash('ENRICH', provider, domain, candidates);
  if (rows.some((r) => r.provider === provider && r.mode === 'ENRICH' && r.inputHash === enrichHash)) return true;
  if (provider === 'hunter') {
    const dsHash = computeInputHash('DOMAIN_SEARCH_ONLY', 'hunter', domain, candidates);
    if (rows.some((r) => r.provider === 'hunter' && r.mode === 'DOMAIN_SEARCH_ONLY' && r.inputHash === dsHash)) return true;
  }
  return false;
}

/** Classify a single lead. Order is fixed and deterministic: durable-qualification -> current-lifecycle
 * -> domain -> candidates -> already-verified -> chain-exhausted. */
export function classifyLead(
  lead: Lead,
  durablyQualified: boolean,
  officialDomain: string | null,
  candidates: CandidatePerson[] | undefined,
  existingResults: readonly ContactEnrichmentResult[],
  availableProviders: readonly ResolveCascadeProvider[],
  maxOpportunityScore: number | null,
): ClassifyResult {
  if (!durablyQualified) return { eligible: false, reason: 'not_qualified' };
  if (!isLifecycleEligibleForContactWork(lead.status)) return { eligible: false, reason: 'rejected_or_active_outreach' };
  if (!officialDomain) return { eligible: false, reason: 'no_verified_domain' };
  if (!candidates || candidates.length === 0) return { eligible: false, reason: 'no_known_candidates' };
  // A BOUNCED lead's previously-VERIFIED contact is unusable — allow the cascade to resolve a
  // replacement instead of treating the lead as permanently complete.
  const hasUsableVerifiedContact = existingResults.some((r) => r.outcome === 'VERIFIED') && lead.status !== 'BOUNCED';
  if (hasUsableVerifiedContact) return { eligible: false, reason: 'already_verified' };

  const nextSteps: ResolveCascadeProvider[] = [];
  for (const provider of CASCADE_ORDER) {
    if (!availableProviders.includes(provider)) continue;
    if (!isProviderStepResolved(existingResults, provider, officialDomain, candidates)) nextSteps.push(provider);
  }
  if (nextSteps.length === 0) return { eligible: false, reason: 'chain_exhausted' };
  return { eligible: true, target: { lead, domain: officialDomain, candidates, nextSteps, maxOpportunityScore } };
}

export interface ResolveBatchInputs {
  /** Leads with a STATE_TRANSITION to QUALIFIED anywhere in their pipeline_events history — see
   * `PipelineRepository.leadsEverReachedStatus`. Absence means never durably qualified. */
  durablyQualifiedLeadIds: ReadonlySet<string>;
  officialDomainByLead: ReadonlyMap<string, string | null>;
  candidatesByLead: ReadonlyMap<string, CandidatePerson[]>;
  existingResultsByLead: ReadonlyMap<string, ContactEnrichmentResult[]>;
  maxOpportunityScoreByLead: ReadonlyMap<string, number>;
  availableProviders: readonly ResolveCascadeProvider[];
}

export interface ResolveBatchSelection {
  selected: ResolveBatchTarget[];
  skipped: Array<{ lead: Lead; reason: SkipReason }>;
}

/**
 * Classify every candidate lead, then order the eligible ones by strongest existing audit evidence
 * (highest max opportunity score first, no score sorts last) with a stable (createdAt, id) tie-break —
 * same determinism convention as `selectBackfillTargets` — and cap at `opts.limit`. Leads eligible but
 * beyond the limit are neither selected nor reported as skipped (mirrors `selectBackfillTargets`).
 */
export function selectResolveBatchTargets(leads: readonly Lead[], data: ResolveBatchInputs, opts: { limit: number }): ResolveBatchSelection {
  const targets: ResolveBatchTarget[] = [];
  const skipped: ResolveBatchSelection['skipped'] = [];
  for (const lead of leads) {
    const decision = classifyLead(
      lead,
      data.durablyQualifiedLeadIds.has(lead.id),
      data.officialDomainByLead.get(lead.id) ?? null,
      data.candidatesByLead.get(lead.id),
      data.existingResultsByLead.get(lead.id) ?? [],
      data.availableProviders,
      data.maxOpportunityScoreByLead.get(lead.id) ?? null,
    );
    if (!decision.eligible) { skipped.push({ lead, reason: decision.reason }); continue; }
    targets.push(decision.target);
  }
  const ordered = [...targets].sort(
    (a, b) =>
      (b.maxOpportunityScore ?? -1) - (a.maxOpportunityScore ?? -1) ||
      a.lead.createdAt.getTime() - b.lead.createdAt.getTime() ||
      a.lead.id.localeCompare(b.lead.id),
  );
  return { selected: ordered.slice(0, opts.limit), skipped };
}
