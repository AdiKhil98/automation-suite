import {
  computeMissingBackfillFacts,
  selectBackfillTargets,
  type SkipReason,
} from '../../domain/lead-facts/backfill-selection.js';
import { type Lead } from '../../domain/leads/lead.js';
import {
  GooglePlacesDetailsClient,
  placeDetailsCostUsd,
  type PlacesDetailsClient,
} from '../../integrations/enrichment/google-places-details.js';
import {
  type BackfillFactType,
  DrizzleGooglePlaceDetailsStore,
} from '../../persistence/google-place-details-store.js';
import { LeadFactsRepository } from '../../persistence/repositories/lead-facts.repo.js';
import { AppError } from '../../utils/errors.js';
import { type CliContext } from '../context.js';

export interface PlacesBackfillOptions {
  lead?: string;
  limit?: string;
  plan?: boolean;
  confirm?: boolean;
  includeActive?: boolean;
}

/** Test seam: inject a details client so unit/integration tests make no real API call. */
export interface PlacesBackfillDeps {
  detailsClient?: PlacesDetailsClient;
}

const SKIP_LABEL: Record<SkipReason, string> = {
  no_place_id: 'no google_place_id',
  excluded_outreach_status: 'excluded outreach state (use --lead … --include-active)',
  lead_not_found: 'lead not found',
};

interface PerLead {
  lead: Lead;
  missing: BackfillFactType[];
}

/**
 * State-neutral, missing-only Google Places backfill of rating/review_count/phone.
 *
 * Plan mode (default; also when --confirm is absent) makes ZERO API calls and only reports what
 * WOULD be backfilled. A live run requires --confirm plus the existing paid-read gates and is
 * bounded by the existing per-run request/cost caps. It never changes lead state, never runs
 * qualification/verification/capture/audit, never composes/sends, and writes only the three
 * missing facts through the construction-enforced `backfillMissing` path.
 */
export async function placesBackfillCommand(
  ctx: CliContext,
  opts: PlacesBackfillOptions,
  deps: PlacesBackfillDeps = {},
): Promise<void> {
  const c = ctx.config;
  const live = opts.confirm === true;
  const includeActive = opts.includeActive === true;
  const limit = opts.limit ? Number.parseInt(opts.limit, 10) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new AppError('INVALID_LIMIT', '--limit must be a positive integer.');
  }

  const all = await ctx.leads.list(1000);
  const { selected, skipped } = selectBackfillTargets(all, { lead: opts.lead, limit, includeActive });

  // Determine per-lead missing facts (read-only).
  const factsRepo = new LeadFactsRepository(ctx.db);
  const candidates: PerLead[] = [];
  let nothingMissing = 0;
  for (const lead of selected) {
    const current = await factsRepo.listCurrentFacts(lead.id);
    const missing = computeMissingBackfillFacts(new Set(current.map((f) => f.factType)));
    if (missing.length === 0) { nothingMissing += 1; continue; }
    candidates.push({ lead, missing });
  }

  console.log(`\nplaces-backfill (${live ? 'LIVE' : 'PLAN'}) — writes only rating/review_count/phone, missing-only, state-neutral`);
  console.log(`  selected leads:            ${selected.length}`);
  console.log(`  already complete (skipped):${nothingMissing}`);
  console.log(`  would backfill:            ${candidates.length}`);
  if (skipped.length > 0) {
    const byReason = new Map<SkipReason, number>();
    for (const s of skipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
    for (const [reason, n] of byReason) console.log(`  skipped (${SKIP_LABEL[reason]}): ${n}`);
  }
  const projectedCost = placeDetailsCostUsd(candidates.length);
  console.log(`  projected Place Details reads: ${candidates.length} (Enterprise SKU)`);
  console.log(`  projected cost:            $${projectedCost.toFixed(4)} (cap $${c.MAX_GOOGLE_CONTEXT_COST_USD_PER_RUN.toFixed(2)}/run, ${String(c.MAX_GOOGLE_CONTEXT_REQUESTS_PER_RUN)} reads/run)`);

  for (const { lead, missing } of candidates) {
    console.log(`    ${lead.id}  ${lead.businessName ?? '(unknown)'}  [${lead.status}]  missing: ${missing.join(', ')}`);
  }

  if (!live) {
    console.log('\n  PLAN mode: no API call, nothing written. Re-run with --confirm (and paid-read env) to backfill.');
    return;
  }

  // ---- Live paid run: gates + bounded loop ----
  if (!c.ALLOW_PAID_READS) throw new AppError('PAID_READS_DISABLED', 'Live backfill requires ALLOW_PAID_READS=true.');
  const client = deps.detailsClient
    ?? (c.GOOGLE_PLACES_API_KEY
      ? new GooglePlacesDetailsClient(c.GOOGLE_PLACES_API_KEY, c.ENRICH_HTTP_TIMEOUT_MS, ctx.logger)
      : null);
  if (!client) throw new AppError('PLACES_KEY_MISSING', 'Live backfill requires GOOGLE_PLACES_API_KEY.');

  const store = new DrizzleGooglePlaceDetailsStore(ctx.db);
  let reads = 0;
  let cost = 0;
  let written = 0;
  console.log('');
  for (const { lead } of candidates) {
    const projected = placeDetailsCostUsd(reads + 1);
    if (reads >= c.MAX_GOOGLE_CONTEXT_REQUESTS_PER_RUN || projected > c.MAX_GOOGLE_CONTEXT_COST_USD_PER_RUN) {
      console.log(`  budget reached after ${String(reads)} reads; stopping (remaining leads untouched).`);
      break;
    }
    const placeId = lead.placeId;
    if (!placeId) continue; // selection guarantees a placeId; defensive only
    const details = await client.details(placeId, { includePhone: true });
    reads += 1;
    cost = placeDetailsCostUsd(reads);
    if (!details) { console.log(`    ${lead.id}  no details returned; skipped`); continue; }
    const result = await store.backfillMissing({ leadId: lead.id, placeId, retrievedAt: new Date(), details });
    written += result.writtenTypes.length;
    console.log(`    ${lead.id}  wrote: [${result.writtenTypes.join(', ') || 'none'}]  skipped-existing: [${result.skippedExistingTypes.join(', ') || 'none'}]`);
  }

  console.log(`\n  done: ${String(reads)} reads, ${String(written)} facts written, est. spend $${cost.toFixed(4)}.`);
  console.log('  No lead state changed. No qualification, verification, capture, audit, email, or send occurred.');
}
