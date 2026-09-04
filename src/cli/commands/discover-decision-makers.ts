import { assertLiveCallsAllowed } from '../../config/live-call-guard.js';
import {
  readCandidatesFileIfExists,
  saveCandidatesFile,
  type CandidatesFileData,
} from '../../domain/contact-resolve-batch/candidates-file.js';
import {
  buildResultRecord,
  computeExtractionFingerprint,
  decideAttempt,
  MAX_PAID_ATTEMPTS_PER_FINGERPRINT,
  readResultsManifestIfExists,
  saveResultsManifest,
  SKIP_REASON_LABEL,
  type ExtractionOutcomeKind,
  type ResultsManifest,
} from '../../domain/decision-makers/results-manifest.js';
import { DECISION_MAKER_SCHEMA_VERSION } from '../../domain/decision-makers/schema.js';
import { extractDecisionMakers, type DecisionMakerLlmDeps, type ExtractionCallMetadata } from '../../domain/decision-makers/service.js';
import { buildSafeHttpFetcher, gatherWebsiteEvidence, type PageFetchFn } from '../../domain/decision-makers/website-evidence.js';
import { isLifecycleEligibleForContactWork } from '../../domain/leads/lead-lifecycle.js';
import { type Lead } from '../../domain/leads/lead.js';
import { ContactEnrichmentRepository } from '../../persistence/repositories/contact-enrichment.repo.js';
import { LeadFactsRepository } from '../../persistence/repositories/lead-facts.repo.js';
import { EXTRACTOR_PROMPT_VERSION } from '../../prompts/decision-makers/index.js';
import { AppError } from '../../utils/errors.js';
import { type CliContext } from '../context.js';
import { buildDecisionMakerLlmDeps } from './discover-decision-makers-build.js';

export interface DiscoverDecisionMakersOptions {
  out?: string;
  results?: string;
  lead?: string;
  limit?: string;
  preview?: boolean;
  confirm?: boolean;
  refresh?: boolean;
}

/** Test seam: inject the page fetcher / LLM deps so unit/integration tests make no real network/LLM call. */
export interface DiscoverDecisionMakersDeps {
  buildFetcher?: (ctx: CliContext) => PageFetchFn;
  buildLlmDeps?: (ctx: CliContext) => DecisionMakerLlmDeps;
  /** Test seam: deterministic clock for manifest timestamps. */
  now?: () => Date;
}

const DEFAULT_OUT = '.local-data/decision-makers/candidates.json';
const DEFAULT_RESULTS = '.local-data/decision-makers/results.json';
/** Failure summaries stored in the manifest are bounded — they are provenance, not a log. */
const MAX_NOTE_CHARS = 300;

function defaultBuildFetcher(ctx: CliContext): PageFetchFn {
  const c = ctx.config;
  return buildSafeHttpFetcher({ timeoutMs: c.ENRICH_HTTP_TIMEOUT_MS, maxRedirects: c.ENRICH_MAX_REDIRECTS, maxBytes: c.ENRICH_MAX_BYTES });
}

function parsePositiveInt(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) throw new AppError('INVALID_ARGUMENT', `${flag} must be a positive integer (got "${value}").`);
  return n;
}

function truncateNote(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= MAX_NOTE_CHARS ? trimmed : `${trimmed.slice(0, MAX_NOTE_CHARS - 1)}…`;
}

/** One-line spend/provenance summary for a COMPLETED paid request — printed on success and, more
 * importantly, on failure, so a schema-invalid paid call is never financially invisible. Contains no
 * model output and no secrets. */
function formatCall(call: ExtractionCallMetadata): string {
  const n = (v: number | null): string => (v === null ? 'n/a' : String(v));
  const cost = call.estimatedCostUsd === null ? 'unknown' : `$${call.estimatedCostUsd.toFixed(4)}`;
  return `paid call: calls=${String(call.llmCalls)} model=${call.resolvedModel ?? call.requestedModel} tokens in=${n(call.inputTokens)} out=${n(call.outputTokens)} total=${n(call.totalTokens)} est.cost=${cost} outcome=${call.failureCategory} requestId=${call.requestId ?? 'n/a'}`;
}

function resolveOfficialBaseUrl(officialDomain: string, officialWebsiteUrl: string | null): string {
  if (officialWebsiteUrl) return officialWebsiteUrl;
  return `https://${officialDomain}`;
}

interface EligibleLead {
  lead: Lead;
  domain: string;
  baseUrl: string;
}

/**
 * Reject combinations whose meaning is undefined rather than silently picking one interpretation.
 *
 * The important one is `--refresh --confirm` without `--lead`: refresh bypasses every idempotency
 * guard, so in batch mode it would re-extract "whichever leads happen to sort first by createdAt" at
 * full price — including leads already solved. Refresh is an operator override, and an override needs
 * a target.
 */
function assertUsableOptions(opts: DiscoverDecisionMakersOptions): void {
  if (opts.preview === true && opts.confirm === true) {
    throw new AppError('INVALID_ARGUMENT', '--preview and --confirm are mutually exclusive: --preview is the free fetch-only run, --confirm performs the paid extraction.');
  }
  if (opts.lead !== undefined && opts.lead.trim() === '') {
    throw new AppError('INVALID_ARGUMENT', '--lead requires a lead id.');
  }
  if (opts.lead !== undefined && opts.limit !== undefined) {
    throw new AppError('INVALID_ARGUMENT', '--lead targets exactly one lead, so --limit is meaningless. Use one or the other.');
  }
  if (opts.refresh === true && opts.confirm === true && opts.lead === undefined) {
    throw new AppError(
      'INVALID_ARGUMENT',
      '--refresh with --confirm requires --lead <leadId>. Refresh bypasses every idempotency guard, so in batch mode it would re-run paid extraction on whichever leads sort first — including ones already solved. Target the lead you actually want to re-extract.',
    );
  }
}

/**
 * Evidence-bound decision-maker discovery from a lead's own official website — the missing producer
 * for `contact-resolve-batch --candidates-file`. Never calls Instantly/Hunter/Apollo/any
 * email-enrichment provider (no import of those modules exists in this file or anything it depends
 * on) and never writes lead_facts.
 *
 * Two local files, each with one job:
 *   --out     candidates.json — WHAT WE FOUND. Only leads with >=1 accepted decision-maker; the exact
 *             format `contact-resolve-batch --candidates-file` consumes, unchanged.
 *   --results results.json    — WHAT WE DID. Every completed attempt, keyed by lead, carrying the
 *             input fingerprint + outcome + spend. Read only by this command, to avoid paying twice
 *             for the same question.
 *
 * Default (no flags): pure projection, zero network/LLM. `--preview`: live, FREE page-fetch + link
 * discovery only (no LLM call) — shows what WOULD be sent, including the idempotency verdict.
 * `--confirm`: fetch + LLM extraction + deterministic filter. DRY_RUN=true blocks BOTH `--preview`
 * and `--confirm` (a live fetch to a third-party site is a live network call, same as the paid LLM
 * step) — checked once, up front, before any lead is touched.
 */
export async function discoverDecisionMakersCommand(ctx: CliContext, opts: DiscoverDecisionMakersOptions, deps: DiscoverDecisionMakersDeps = {}): Promise<void> {
  assertUsableOptions(opts);
  const c = ctx.config;
  const now = deps.now ?? ((): Date => new Date());
  const live = opts.preview === true || opts.confirm === true;
  const outPath = opts.out ?? DEFAULT_OUT;
  const resultsPath = opts.results ?? DEFAULT_RESULTS;
  const targetLeadId = opts.lead?.trim();
  const limit = targetLeadId
    ? 1
    : Math.min(parsePositiveInt(opts.limit, '--limit', c.DISCOVER_DECISION_MAKERS_MAX_LEADS_PER_RUN), c.DISCOVER_DECISION_MAKERS_MAX_LEADS_PER_RUN);

  const existing: CandidatesFileData = readCandidatesFileIfExists(outPath) ?? {};
  const manifest: ResultsManifest = readResultsManifestIfExists(resultsPath);

  const all = await ctx.leads.list(1000);
  // Durable qualification: did this lead EVER pass QUALIFIED, per the append-only pipeline_events
  // history — not whether its CURRENT status literally equals 'QUALIFIED' (QUALIFIED's only legal
  // outgoing transition is to READY_FOR_CAPTURE, so an audited/captured lead has long since moved past
  // it and would otherwise be invisible here). Current-status lifecycle viability (rejected / opted out
  // / active outreach in flight) is still enforced separately below.
  const everQualified = await ctx.events.leadsEverReachedStatus(all.map((l) => l.id), 'QUALIFIED');
  const qualified = all.filter((l) => everQualified.has(l.id) && isLifecycleEligibleForContactWork(l.status));

  // --lead narrows the candidate set but relaxes NOTHING: every qualification, lifecycle, domain and
  // contact safety check below still applies to that one lead.
  if (targetLeadId && !all.some((l) => l.id === targetLeadId)) {
    throw new AppError('LEAD_NOT_FOUND', `--lead "${targetLeadId}" matched no lead in the most recent 1000 leads.`);
  }
  const scope = targetLeadId ? qualified.filter((l) => l.id === targetLeadId) : qualified;
  if (targetLeadId && scope.length === 0) {
    throw new AppError('LEAD_NOT_ELIGIBLE', `--lead "${targetLeadId}" exists but is not eligible for decision-maker work: it never durably reached QUALIFIED, or its current status excludes new contact work.`);
  }

  const factsRepo = new LeadFactsRepository(ctx.db);
  const enrichRepo = new ContactEnrichmentRepository(ctx.db);
  const eligible: EligibleLead[] = [];
  const skipped: Array<{ lead: Lead; reason: string }> = [];
  // In --confirm, `limit` bounds PAID ATTEMPTS, not leads examined: a lead the manifest turns away
  // costs nothing and must not consume the run's budget slot, or a growing tail of settled leads
  // would starve every new one. Examination stays bounded by the env hard cap.
  const selectionCap = opts.confirm === true ? c.DISCOVER_DECISION_MAKERS_MAX_LEADS_PER_RUN : limit;
  for (const lead of scope) {
    const domainFact = await factsRepo.getCurrentFact(lead.id, 'official_domain');
    if (!domainFact) { skipped.push({ lead, reason: 'no_verified_domain' }); continue; }
    // A BOUNCED lead's previously-VERIFIED contact is unusable — allow fresh discovery for a
    // replacement rather than treating the lead as permanently complete.
    if (lead.status !== 'BOUNCED') {
      const enrichResults = await enrichRepo.listByLead(lead.id);
      if (enrichResults.some((r) => r.outcome === 'VERIFIED')) {
        skipped.push({ lead, reason: 'already_verified_contact' });
        continue;
      }
    }
    // Cheap pre-fetch guard, unchanged: a lead already holding accepted candidates needs no re-crawl.
    // Leads settled as NO_CANDIDATE/SCHEMA_INVALID/exhausted are NOT skipped here — they are re-fetched
    // (free) so the manifest can compare the current evidence fingerprint and re-open them if the
    // website actually changed.
    if (!opts.refresh && existing[lead.id] && existing[lead.id].length > 0) {
      skipped.push({ lead, reason: 'already_in_out_file' });
      continue;
    }
    const websiteUrlFact = await factsRepo.getCurrentFact(lead.id, 'official_website_url');
    eligible.push({ lead, domain: domainFact.value, baseUrl: resolveOfficialBaseUrl(domainFact.value, websiteUrlFact?.value ?? null) });
    if (eligible.length >= selectionCap) break;
  }

  const modeLabel = opts.confirm ? 'LIVE --confirm' : opts.preview ? 'LIVE --preview (free, no LLM)' : 'PLAN';
  console.log(`\n=== discover-decision-makers (${modeLabel}) ===`);
  if (targetLeadId) console.log(`  target lead:            ${targetLeadId}`);
  if (opts.refresh) console.log(`  refresh:                ON (idempotency guards bypassed for this scope)`);
  console.log(`  qualified leads scanned: ${String(scope.length)}`);
  console.log(`  selected this run:       ${String(eligible.length)}${opts.confirm ? ` (max paid attempts ${String(limit)})` : ` (limit ${String(limit)})`}`);
  if (skipped.length > 0) {
    const byReason = new Map<string, number>();
    for (const s of skipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
    for (const [reason, n] of byReason) console.log(`  skipped (${reason}): ${String(n)}`);
  }

  if (!live) {
    for (const { lead, domain, baseUrl } of eligible) {
      const record = manifest.results[lead.id];
      const recorded = record ? ` [recorded ${record.outcome}, attempts ${String(record.attempts)}]` : ' [no recorded result]';
      console.log(`  lead ${lead.id} → domain ${domain} → would fetch ${baseUrl}${recorded}`);
    }
    console.log('\n  PLAN mode: no fetch, no LLM call, nothing written. Re-run with --preview (free) or --confirm.');
    return;
  }

  // Global DRY_RUN kill switch: a live fetch to a third-party site is a live network call, same as the
  // paid LLM step — blocked up front, before any lead is touched, exactly like every other live path.
  assertLiveCallsAllowed(c.DRY_RUN, 'discover-decision-makers-fetch');

  const fetcher = (deps.buildFetcher ?? defaultBuildFetcher)(ctx);
  const llmDeps = opts.confirm ? (deps.buildLlmDeps ?? buildDecisionMakerLlmDeps)(ctx) : null;

  let llmCallsThisRun = 0;
  let paidAttemptsThisRun = 0;
  let runCostUsd = 0;
  let leadsWritten = 0;
  let manifestUpdates = 0;
  console.log('');
  for (const { lead, domain, baseUrl } of eligible) {
    if (opts.confirm && paidAttemptsThisRun >= limit) {
      console.log(`  --limit reached (${String(paidAttemptsThisRun)} paid attempt${paidAttemptsThisRun === 1 ? '' : 's'}); remaining leads untouched.`);
      break;
    }
    const { pages, fetchErrors, fetchCount, selection } = await gatherWebsiteEvidence(fetcher, baseUrl, c.DISCOVER_DECISION_MAKERS_MAX_PAGES_PER_LEAD);
    const pageSummary = pages.map((p) => `${p.role}:${p.url}`).join(', ') || '(none)';

    // The fingerprint needs the evidence, so it is computed after the (free) fetch and before the
    // (paid) call. That ordering is what lets a genuine website change re-open a settled lead.
    const fingerprint = pages.length > 0 && llmDeps
      ? computeExtractionFingerprint({
        leadId: lead.id,
        officialDomain: domain,
        pages,
        promptVersion: EXTRACTOR_PROMPT_VERSION,
        schemaVersion: DECISION_MAKER_SCHEMA_VERSION,
        provider: llmDeps.provider.name,
        model: llmDeps.model,
        minConfidence: llmDeps.minConfidence,
      })
      : null;
    const previous = manifest.results[lead.id];
    const decision = fingerprint ? decideAttempt(previous, fingerprint, opts.refresh === true) : null;

    if (!opts.confirm) {
      console.log(`  lead ${lead.id} → domain ${domain} → ${String(fetchCount)}/${String(c.DISCOVER_DECISION_MAKERS_MAX_PAGES_PER_LEAD)} fetches → pages: ${pageSummary}${fetchErrors.length > 0 ? ` (errors: ${fetchErrors.join('; ')})` : ''}`);
      for (const line of selection) console.log(`      ${line}`);
      if (previous) console.log(`      recorded: ${previous.outcome} (attempts ${String(previous.attempts)}, last ${previous.lastAttemptAt})`);
      continue;
    }

    if (!llmDeps || !fingerprint || !decision) {
      // No evidence gathered: no request is possible, nothing is billable, and nothing is recorded —
      // the lead stays eligible for a later run.
      console.log(`  lead ${lead.id} → domain ${domain} → no_pages${fetchErrors.length > 0 ? `: ${fetchErrors.join('; ')}` : ''} — no LLM call, nothing recorded, still eligible.`);
      continue;
    }

    if (!decision.attempt) {
      console.log(`  lead ${lead.id} → domain ${domain} → SKIPPED (no paid call): ${SKIP_REASON_LABEL[decision.reason]}`);
      console.log(`      recorded: ${previous?.outcome ?? 'n/a'} attempts=${String(previous?.attempts ?? 0)} spent=$${(previous?.totalCostUsd ?? 0).toFixed(4)} at ${previous?.lastAttemptAt ?? 'n/a'}`);
      continue;
    }

    if (llmCallsThisRun >= c.MAX_LLM_CALLS_PER_RUN) {
      console.log(`  lead ${lead.id} → run-wide LLM call budget reached (${String(llmCallsThisRun)}/${String(c.MAX_LLM_CALLS_PER_RUN)}); remaining leads untouched.`);
      break;
    }

    const result = await extractDecisionMakers(llmDeps, pages, lead.businessName, c.DISCOVER_DECISION_MAKERS_MAX_PAGES_PER_LEAD);

    // Run-budget accounting is driven by what the provider actually did, never by assuming a call
    // happened: `no_pages` and `budget_blocked` return no call metadata and cost nothing, so they
    // must not consume the run allowance or the paid-attempt limit.
    const call = 'call' in result ? result.call : null;
    if (call) {
      llmCallsThisRun += call.llmCalls;
      paidAttemptsThisRun += 1;
      runCostUsd += call.estimatedCostUsd ?? 0;
    }

    // Neither state issues a provider request, so neither is billable, recorded, or budget-consuming;
    // both leave the lead eligible for a later run. (`no_pages` is unreachable here — an empty page
    // set is caught above — but the union is handled exhaustively rather than assumed.)
    if (result.status === 'budget_blocked' || result.status === 'no_pages') {
      const why = result.status === 'budget_blocked' ? 'projected cost exceeds MAX_LLM_COST_USD_PER_LEAD' : 'no evidence pages';
      console.log(`  lead ${lead.id} → domain ${domain} → ${result.status} (${why}) — no LLM call, nothing recorded, still eligible.`);
      continue;
    }

    let outcome: ExtractionOutcomeKind;
    let acceptedCount = 0;
    let note: string | null = null;

    if (result.status === 'ok') {
      acceptedCount = result.accepted.length;
      outcome = acceptedCount > 0 ? 'FOUND' : 'NO_CANDIDATE';
      console.log(
        `  lead ${lead.id} → domain ${domain} → pages: ${pageSummary} → accepted: ${result.accepted.map((a) => `${a.fullName} (${a.title}, tier ${String(a.priority)})`).join(', ') || 'none'} → rejected: ${result.rejected.map((r) => `${r.fullName}[${r.reason}]`).join(', ') || 'none'} (cost $${result.costUsd.toFixed(4)})`,
      );
      console.log(`      ${formatCall(result.call)}`);
      if (acceptedCount > 0) {
        existing[lead.id] = result.accepted.map((a) => ({
          fullName: a.fullName, title: a.title, sourceUrl: a.sourceUrl, evidenceSnippet: a.evidenceSnippet, confidence: a.confidence,
        }));
        saveCandidatesFile(outPath, existing);
        leadsWritten += 1;
      } else {
        note = result.insufficientEvidence ? 'model reported insufficient evidence' : 'no candidate survived the deterministic filter';
        console.log(`      no accepted candidates — candidates file NOT written for this lead; any existing file left unchanged.`);
      }
    } else if (result.status === 'schema_invalid') {
      outcome = 'SCHEMA_INVALID';
      note = truncateNote(result.errors.join('; '));
      console.log(`  lead ${lead.id} → domain ${domain} → schema_invalid: ${result.errors.join('; ')}`);
      if (result.call) console.log(`      ${formatCall(result.call)}`);
      console.log(`      candidates file NOT written for this lead; any existing file left unchanged.`);
    } else {
      outcome = 'PROVIDER_ERROR';
      note = truncateNote(result.message);
      console.log(`  lead ${lead.id} → domain ${domain} → provider_error: ${result.message}`);
      if (result.call) console.log(`      ${formatCall(result.call)}`);
      console.log(`      candidates file NOT written for this lead; any existing file left unchanged.`);
    }

    manifest.results[lead.id] = buildResultRecord({ previous, fingerprint, outcome, acceptedCount, call, note, now: now() });
    saveResultsManifest(resultsPath, manifest);
    manifestUpdates += 1;
    const updated = manifest.results[lead.id];
    const budget = outcome === 'PROVIDER_ERROR' ? `/${String(MAX_PAID_ATTEMPTS_PER_FINGERPRINT)}` : '';
    console.log(`      recorded ${outcome} (paid attempts ${String(updated?.attempts ?? 0)}${budget}) in ${resultsPath}`);
  }

  // Truthful epilogue: only claim a write that actually happened. A failed lead must never be
  // reported as having produced a file, and never overwrites valid prior results with an empty one.
  if (leadsWritten > 0) {
    console.log(`\n  wrote: ${outPath} (${String(leadsWritten)} lead${leadsWritten === 1 ? '' : 's'} updated)`);
  } else {
    console.log(`\n  no candidates file was produced or updated; ${outPath} left unchanged.`);
  }
  if (opts.confirm) {
    console.log(`  results manifest: ${String(manifestUpdates)} record${manifestUpdates === 1 ? '' : 's'} written to ${resultsPath}`);
    console.log(`  run spend: ${String(llmCallsThisRun)} paid LLM call${llmCallsThisRun === 1 ? '' : 's'}, est. $${runCostUsd.toFixed(4)}`);
  }
  console.log('  No Instantly/Hunter/Apollo/email-enrichment call was made. No lead_facts written. No lead state changed.');
}
