import { DryRunLiveCallError } from '../../config/live-call-guard.js';
import { EnrichmentProviderNotAllowedError, type ContactEnrichmentProvider } from '../../domain/contact-enrichment/provider.js';
import { ContactEnrichmentService, type EnrichmentRunCaps } from '../../domain/contact-enrichment/service.js';
import { type ContactEnrichmentResult } from '../../domain/contact-enrichment/types.js';
import { loadCandidatesFile } from '../../domain/contact-resolve-batch/candidates-file.js';
import {
  CASCADE_ORDER,
  selectResolveBatchTargets,
  type ResolveCascadeProvider,
  type SkipReason,
} from '../../domain/contact-resolve-batch/eligibility.js';
import { evaluateOfficialInboxFallback } from '../../domain/contact-resolution/official-inbox-fallback.js';
import { toIntendedDecisionMakers } from '../../domain/contact-resolution/resolution.js';
import { isLifecycleEligibleForContactWork } from '../../domain/leads/lead-lifecycle.js';
import { ContactEnrichmentRepository } from '../../persistence/repositories/contact-enrichment.repo.js';
import { ContactResolutionRepository } from '../../persistence/repositories/contact-resolution.repo.js';
import { AuditRepository } from '../../persistence/repositories/audit.repo.js';
import { LeadFactsRepository } from '../../persistence/repositories/lead-facts.repo.js';
import { AppError } from '../../utils/errors.js';
import { type LeadFact } from '../../domain/lead-facts/lead-fact.js';
import { type CliContext } from '../context.js';
import { buildHunterContactEnrichmentProvider, buildInstantlyContactEnrichmentProvider } from './contact-enrich-build.js';

export interface ContactResolveBatchOptions {
  candidatesFile?: string;
  limit?: string;
  confirm?: boolean;
  maxTotalRequests?: string;
  maxTotalCredits?: string;
  stopAfterFirstVerified?: boolean;
}

/** Test seam: inject provider construction so unit/integration tests make no real network call. */
export interface ContactResolveBatchDeps {
  buildProvider?: (name: ResolveCascadeProvider, ctx: CliContext) => ContactEnrichmentProvider;
}

function defaultBuildProvider(name: ResolveCascadeProvider, ctx: CliContext): ContactEnrichmentProvider {
  return name === 'instantly' ? buildInstantlyContactEnrichmentProvider(ctx) : buildHunterContactEnrichmentProvider(ctx);
}

const SKIP_LABEL: Record<SkipReason, string> = {
  not_qualified: 'not QUALIFIED',
  rejected_or_active_outreach: 'rejected or active outreach',
  no_verified_domain: 'no verified official_domain fact',
  no_known_candidates: 'no known decision-maker candidates in --candidates-file',
  already_verified: 'already holds a VERIFIED decision-maker email',
  no_providers_configured: 'personal cascade steps remain but NO provider is configured (nothing concluded)',
  personal_chain_exhausted: 'personal Instantly/Hunter cascade conclusively exhausted',
};

function parsePositiveInt(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) throw new AppError('INVALID_ARGUMENT', `${flag} must be a positive integer (got "${value}").`);
  return n;
}

/**
 * Bounded, multi-lead decision-maker resolver: walks qualified leads (strongest audit evidence first),
 * and for each tries the existing Instantly -> Hunter cascade until ONE lead yields a genuinely VERIFIED
 * decision-maker email, or every eligible lead in this run is exhausted. Apollo is never called (kept in
 * the repo, unavailable on the current Apollo plan). Never generates or sends email; never touches
 * lead_facts; never force-refreshes; fails closed and moves to the next lead on an unexpected error.
 *
 * PLAN mode (default): pure read-only projection — no provider constructed, no network, no spend.
 * LIVE mode (--confirm): fails fast if DRY_RUN=true; a provider missing its own config (key/enabled) is
 * silently excluded from the cascade for this run rather than failing the whole command.
 *
 * GENERIC_OFFICIAL FALLBACK. After (and only after) a lead's personal cascade is conclusively
 * exhausted — every provider in CASCADE_ORDER has a persisted row at the current candidate hash and
 * none produced a VERIFIED person — the run may fall back to an ALREADY-STORED, website-sourced
 * `contact_email` fact and resolve the lead to the business's own generic inbox. The fallback is
 * fully deterministic: it makes no provider, network, LLM or crawl call and consumes ZERO credits,
 * because its only input is a fact the capture pipeline already persisted. It never short-circuits
 * the personal chain (a lead with pending cascade steps is not a fallback candidate), and it never
 * attaches a named person to the mailbox — see `contact_resolutions_intended_ck`.
 */
export async function contactResolveBatchCommand(ctx: CliContext, opts: ContactResolveBatchOptions, deps: ContactResolveBatchDeps = {}): Promise<void> {
  const buildProvider = deps.buildProvider ?? defaultBuildProvider;
  const c = ctx.config;
  const live = opts.confirm === true;

  if (!opts.candidatesFile) throw new AppError('CANDIDATES_FILE_REQUIRED', '--candidates-file <path> is required.');
  const candidatesByLead = loadCandidatesFile(opts.candidatesFile);

  const limit = Math.min(
    parsePositiveInt(opts.limit, '--limit', c.CONTACT_RESOLVE_BATCH_MAX_LEADS_PER_RUN),
    c.CONTACT_RESOLVE_BATCH_MAX_LEADS_PER_RUN,
  );
  const maxTotalRequests = parsePositiveInt(opts.maxTotalRequests, '--max-total-requests', c.CONTACT_RESOLVE_BATCH_MAX_REQUESTS_PER_RUN);
  const maxTotalCredits = parsePositiveInt(opts.maxTotalCredits, '--max-total-credits', c.CONTACT_RESOLVE_BATCH_MAX_CREDITS_PER_RUN);

  const enrichRepo = new ContactEnrichmentRepository(ctx.db);
  const factsRepo = new LeadFactsRepository(ctx.db);
  const auditRepo = new AuditRepository(ctx.db);

  const all = await ctx.leads.list(1000);
  // Durable qualification: did this lead EVER pass QUALIFIED, per the append-only pipeline_events
  // history — not whether its CURRENT status literally equals 'QUALIFIED' (QUALIFIED's only legal
  // outgoing transition is to READY_FOR_CAPTURE, so an audited/captured lead has long since moved past
  // it). Computed over every lead (not just the lifecycle-viable ones) so `classifyLead` can still
  // report the more specific 'rejected_or_active_outreach' reason for a durably-qualified lead whose
  // current status now blocks new contact work.
  const durablyQualifiedLeadIds = await ctx.events.leadsEverReachedStatus(all.map((l) => l.id), 'QUALIFIED');
  const qualified = all.filter((l) => durablyQualifiedLeadIds.has(l.id) && isLifecycleEligibleForContactWork(l.status));

  const officialDomainByLead = new Map<string, string | null>();
  const existingResultsByLead = new Map<string, ContactEnrichmentResult[]>();
  const contactEmailFactByLead = new Map<string, LeadFact | null>();
  for (const lead of qualified) {
    const fact = await factsRepo.getCurrentFact(lead.id, 'official_domain');
    officialDomainByLead.set(lead.id, fact?.value ?? null);
    existingResultsByLead.set(lead.id, await enrichRepo.listByLead(lead.id));
    // Read-only input to the GENERIC_OFFICIAL fallback. Never written or superseded by this command.
    contactEmailFactByLead.set(lead.id, await factsRepo.getCurrentFact(lead.id, 'contact_email'));
  }
  const maxOpportunityScoreByLead = await auditRepo.maxOpportunityScores(qualified.map((l) => l.id));

  // ---- Determine this run's available cascade providers ----
  // PLAN mode: env-presence only, zero construction/network. LIVE mode: actually attempt construction
  // so the selection reflects reality (a DRY_RUN block is fatal for the whole run; a missing
  // key/disabled flag just excludes that provider from the cascade for this run).
  let availableProviders: ResolveCascadeProvider[];
  const services = new Map<ResolveCascadeProvider, ContactEnrichmentService>();
  if (live) {
    for (const name of CASCADE_ORDER) {
      try {
        const provider = buildProvider(name, ctx);
        services.set(name, new ContactEnrichmentService({ provider, store: enrichRepo, logger: ctx.logger }));
      } catch (err) {
        if (err instanceof DryRunLiveCallError) throw err;
        if (!(err instanceof EnrichmentProviderNotAllowedError)) throw err;
        ctx.logger.warn({ provider: name, reason: err.message }, 'contact-resolve-batch: provider not configured, excluded from this run');
      }
    }
    availableProviders = [...services.keys()];
  } else {
    availableProviders = CASCADE_ORDER.filter((name) =>
      c.CONTACT_ENRICHMENT_ENABLED && Boolean(name === 'instantly' ? c.INSTANTLY_API_KEY : c.HUNTER_API_KEY));
  }

  const { selected, skipped, fallbackCandidates } = selectResolveBatchTargets(
    all,
    { durablyQualifiedLeadIds, officialDomainByLead, candidatesByLead, existingResultsByLead, maxOpportunityScoreByLead, availableProviders },
    { limit },
  );

  // ---- GENERIC_OFFICIAL fallback (deterministic; zero provider calls, zero credits) ----
  // Evaluated only for leads whose personal cascade is already conclusively exhausted. Pure local
  // computation over facts that are already in the database.
  const resolutionRepo = new ContactResolutionRepository(ctx.db);
  const fallbackAccepted: Array<{ leadId: string; email: string; sourceFactId: string; sourceUrl: string; candidates: typeof fallbackCandidates[number]['candidates'] }> = [];
  const fallbackRejected: Array<{ leadId: string; reason: string }> = [];
  for (const fc of fallbackCandidates) {
    // A lead already holding a current resolution needs no re-resolution; never overwrite a
    // PERSONAL_VERIFIED recipient with a generic inbox.
    const existing = await resolutionRepo.getCurrent(fc.lead.id);
    if (existing) {
      fallbackRejected.push({ leadId: fc.lead.id, reason: `already resolved as ${existing.resolutionType}` });
      continue;
    }
    const decision = evaluateOfficialInboxFallback(fc.domain, contactEmailFactByLead.get(fc.lead.id) ?? null);
    if (decision.accepted) {
      fallbackAccepted.push({
        leadId: fc.lead.id, email: decision.email, sourceFactId: decision.sourceFactId,
        sourceUrl: decision.sourceUrl, candidates: fc.candidates,
      });
    } else {
      fallbackRejected.push({ leadId: fc.lead.id, reason: decision.reason });
    }
  }

  const perLeadCaps: EnrichmentRunCaps = {
    maxRequests: c.CONTACT_ENRICHMENT_MAX_REQUESTS_PER_RUN,
    maxCredits: c.CONTACT_ENRICHMENT_MAX_CREDITS_PER_RUN,
    minCreditsPerLookup: 1,
  };

  console.log(`\n=== contact-resolve-batch (${live ? 'LIVE' : 'PLAN'}) ===`);
  console.log(`  qualified leads scanned: ${String(qualified.length)}`);
  console.log(`  selected this run:       ${String(selected.length)} (limit ${String(limit)})`);
  console.log(`  cascade providers:       ${availableProviders.length > 0 ? availableProviders.join(' -> ') : 'NONE configured'}`);
  if (skipped.length > 0) {
    const byReason = new Map<SkipReason, number>();
    for (const s of skipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
    for (const [reason, n] of byReason) console.log(`  skipped (${SKIP_LABEL[reason]}): ${String(n)}`);
  }

  if (!live) {
    let projectedRequests = 0;
    let projectedCredits = 0;
    for (const t of selected) {
      const stepRequests = perLeadCaps.maxRequests * t.nextSteps.length;
      const stepCredits = perLeadCaps.maxCredits * t.nextSteps.length;
      projectedRequests += stepRequests;
      projectedCredits += stepCredits;
      console.log(
        `  lead ${t.lead.id} → domain ${t.domain} → decision-makers: ${String(t.candidates.length)} known → next: ${t.nextSteps.join(' then ')} → est. max spend: ${String(stepRequests)}req/${String(stepCredits)}cr`,
      );
    }
    const overCap = projectedRequests > maxTotalRequests || projectedCredits > maxTotalCredits;
    console.log(`  projected max spend (worst case, every step hits its per-lead cap): ${String(projectedRequests)}req / ${String(projectedCredits)}cr`);
    console.log(`  run-wide caps: ${String(maxTotalRequests)}req / ${String(maxTotalCredits)}cr${overCap ? '  (projected worst case EXCEEDS the run-wide cap — a live run would stop early)' : ''}`);
    printFallbackSection(fallbackAccepted, fallbackRejected, false);
    console.log('\n  PLAN mode: no provider call made, nothing written. Re-run with --confirm for a bounded live run.');
    return;
  }

  // ---- LIVE ----
  // A run with no configured provider is still useful when there is deterministic fallback work to
  // do (the fallback spends nothing and needs no provider). Only a run that can do NEITHER is an error.
  if (services.size === 0 && fallbackAccepted.length === 0) {
    throw new AppError('NO_PROVIDERS_AVAILABLE', 'contact-resolve-batch: no cascade provider is configured (need CONTACT_ENRICHMENT_ENABLED + at least one of INSTANTLY_API_KEY/HUNTER_API_KEY), and no lead qualifies for the zero-cost GENERIC_OFFICIAL fallback.');
  }

  let totalRequests = 0;
  let totalCredits = 0;
  let verifiedCount = 0;
  let unresolvedCount = 0;
  let erroredCount = 0;
  let stoppedEarly: string | null = null;
  console.log('');

  runLoop: for (const target of selected) {
    const stepLines: string[] = [];
    let verified: { fullName: string; email: string } | null = null;
    let errored = false;

    for (const providerName of target.nextSteps) {
      if (totalRequests + perLeadCaps.maxRequests > maxTotalRequests || totalCredits + perLeadCaps.maxCredits > maxTotalCredits) {
        stoppedEarly = `run-wide budget reached after ${String(totalRequests)}req/${String(totalCredits)}cr`;
        if (stepLines.length === 0) break runLoop; // nothing attempted for this lead at all — leave it fully untouched
        break;
      }
      const service = services.get(providerName);
      if (!service) continue; // defensive: selection only offers providers present in `services`
      try {
        const result = await service.run(target.lead.id, target.domain, target.candidates, perLeadCaps, { performEnrichment: true, forceRefresh: false });
        const requestsUsed = (result.provenance as { requestsUsed?: number }).requestsUsed ?? 0;
        totalRequests += requestsUsed;
        totalCredits += result.creditsEstimated;
        stepLines.push(`${providerName}: ${result.outcome} (req ${String(requestsUsed)}, cr ${String(result.creditsEstimated)})`);
        const accepted = result.accepted;
        if (result.outcome === 'VERIFIED' && accepted) {
          verified = { fullName: accepted.fullName, email: accepted.email };
          // Record the terminal PERSONAL_VERIFIED recipient contract. Provenance is the enrichment
          // row itself; no intended-decision-maker list is stored, because the verified person IS
          // the recipient rather than someone we are asking an inbox to forward to.
          await ctx.db.transaction(async (tx) => {
            await new ContactResolutionRepository(tx).writeCurrentResolution({
              leadId: target.lead.id,
              resolutionType: 'PERSONAL_VERIFIED',
              recipientEmail: accepted.email,
              enrichmentResultId: result.id,
            });
          });
          break;
        }
      } catch (err) {
        errored = true;
        stepLines.push(`${providerName}: ERROR (${err instanceof Error ? err.message : String(err)})`);
        ctx.logger.error(
          { leadId: target.lead.id, provider: providerName, err: err instanceof Error ? err.message : String(err) },
          'contact-resolve-batch: provider call failed, moving to next lead',
        );
        break;
      }
    }

    const resultLabel = verified ? `VERIFIED ${verified.fullName} <${verified.email}>` : errored ? 'errored' : 'unresolved';
    console.log(`  lead ${target.lead.id} → ${stepLines.join(' → ')} → RESULT: ${resultLabel}`);
    if (verified) verifiedCount += 1;
    else if (errored) erroredCount += 1;
    else unresolvedCount += 1;

    if (stoppedEarly) break;
    if (verified && opts.stopAfterFirstVerified) {
      stoppedEarly = 'first VERIFIED contact found (--stop-after-first-verified)';
      break;
    }
  }

  // ---- Persist accepted GENERIC_OFFICIAL fallbacks (no provider call, no credit) ----
  let genericCount = 0;
  for (const f of fallbackAccepted) {
    await ctx.db.transaction(async (tx) => {
      await new ContactResolutionRepository(tx).writeCurrentResolution({
        leadId: f.leadId,
        resolutionType: 'GENERIC_OFFICIAL',
        recipientEmail: f.email,
        sourceFactId: f.sourceFactId,
        sourceUrl: f.sourceUrl,
        intendedDecisionMakers: toIntendedDecisionMakers(f.candidates),
      });
    });
    genericCount += 1;
    console.log(`  lead ${f.leadId} → GENERIC_OFFICIAL <${f.email}> (from published contact_email fact ${f.sourceFactId})`);
  }

  console.log(
    `\n  done: ${String(verifiedCount)} PERSONAL_VERIFIED, ${String(genericCount)} GENERIC_OFFICIAL, ${String(unresolvedCount)} unresolved, ${String(erroredCount)} errored. requests=${String(totalRequests)}/${String(maxTotalRequests)} credits=${String(totalCredits)}/${String(maxTotalCredits)}.`,
  );
  printFallbackSection(fallbackAccepted, fallbackRejected, true);
  if (stoppedEarly) console.log(`  stopped early: ${stoppedEarly}. Any remaining selected leads are untouched.`);
  console.log('  No email generated or sent. No lead state changed.');
}

/**
 * Report the deterministic fallback outcome. Printed in both modes so an operator can see, before
 * spending anything, exactly which leads would resolve to a generic inbox and why the rest cannot.
 */
function printFallbackSection(
  accepted: ReadonlyArray<{ leadId: string; email: string; sourceUrl: string }>,
  rejected: ReadonlyArray<{ leadId: string; reason: string }>,
  live: boolean,
): void {
  if (accepted.length === 0 && rejected.length === 0) return;
  console.log('\n  --- GENERIC_OFFICIAL fallback (personal cascade exhausted; 0 provider calls, 0 credits) ---');
  for (const a of accepted) {
    console.log(`  lead ${a.leadId} → ${live ? 'resolved' : 'would resolve'} GENERIC_OFFICIAL <${a.email}> (published at ${a.sourceUrl})`);
  }
  for (const r of rejected) {
    console.log(`  lead ${r.leadId} → stays UNRESOLVED: ${r.reason}`);
  }
}
