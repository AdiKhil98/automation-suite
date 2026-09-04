import { assertLiveCallsAllowed } from '../../config/live-call-guard.js';
import {
  readCandidatesFileIfExists,
  saveCandidatesFile,
  type CandidatesFileData,
} from '../../domain/contact-resolve-batch/candidates-file.js';
import { extractDecisionMakers, type DecisionMakerLlmDeps } from '../../domain/decision-makers/service.js';
import { buildSafeHttpFetcher, gatherWebsiteEvidence, type PageFetchFn } from '../../domain/decision-makers/website-evidence.js';
import { isLifecycleEligibleForContactWork } from '../../domain/leads/lead-lifecycle.js';
import { type Lead } from '../../domain/leads/lead.js';
import { ContactEnrichmentRepository } from '../../persistence/repositories/contact-enrichment.repo.js';
import { LeadFactsRepository } from '../../persistence/repositories/lead-facts.repo.js';
import { AppError } from '../../utils/errors.js';
import { type CliContext } from '../context.js';
import { buildDecisionMakerLlmDeps } from './discover-decision-makers-build.js';

export interface DiscoverDecisionMakersOptions {
  out?: string;
  limit?: string;
  preview?: boolean;
  confirm?: boolean;
  refresh?: boolean;
}

/** Test seam: inject the page fetcher / LLM deps so unit/integration tests make no real network/LLM call. */
export interface DiscoverDecisionMakersDeps {
  buildFetcher?: (ctx: CliContext) => PageFetchFn;
  buildLlmDeps?: (ctx: CliContext) => DecisionMakerLlmDeps;
}

const DEFAULT_OUT = '.local-data/decision-makers/candidates.json';

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
 * Evidence-bound decision-maker discovery from a lead's own official website — the missing producer
 * for `contact-resolve-batch --candidates-file`. Never calls Instantly/Hunter/Apollo/any
 * email-enrichment provider (no import of those modules exists in this file or anything it depends
 * on) and never writes lead_facts; its only output is a `--candidates-file`-compatible JSON file.
 *
 * Default (no flags): pure projection, zero network/LLM. `--preview`: live, FREE page-fetch + link
 * discovery only (no LLM call) — shows what WOULD be sent. `--confirm`: fetch + LLM extraction +
 * deterministic filter, writes `--out`. DRY_RUN=true blocks BOTH `--preview` and `--confirm` (a live
 * fetch to a third-party site is a live network call, same as the paid LLM step) — checked once, up
 * front, before any lead is touched. `--refresh` is the only way to re-process a lead already present
 * in `--out`; never automatic.
 */
export async function discoverDecisionMakersCommand(ctx: CliContext, opts: DiscoverDecisionMakersOptions, deps: DiscoverDecisionMakersDeps = {}): Promise<void> {
  const c = ctx.config;
  const live = opts.preview === true || opts.confirm === true;
  const outPath = opts.out ?? DEFAULT_OUT;
  const limit = Math.min(
    parsePositiveInt(opts.limit, '--limit', c.DISCOVER_DECISION_MAKERS_MAX_LEADS_PER_RUN),
    c.DISCOVER_DECISION_MAKERS_MAX_LEADS_PER_RUN,
  );

  const existing: CandidatesFileData = readCandidatesFileIfExists(outPath) ?? {};

  const all = await ctx.leads.list(1000);
  // Durable qualification: did this lead EVER pass QUALIFIED, per the append-only pipeline_events
  // history — not whether its CURRENT status literally equals 'QUALIFIED' (QUALIFIED's only legal
  // outgoing transition is to READY_FOR_CAPTURE, so an audited/captured lead has long since moved past
  // it and would otherwise be invisible here). Current-status lifecycle viability (rejected / opted out
  // / active outreach in flight) is still enforced separately below.
  const everQualified = await ctx.events.leadsEverReachedStatus(all.map((l) => l.id), 'QUALIFIED');
  const qualified = all.filter((l) => everQualified.has(l.id) && isLifecycleEligibleForContactWork(l.status));

  const factsRepo = new LeadFactsRepository(ctx.db);
  const enrichRepo = new ContactEnrichmentRepository(ctx.db);
  const eligible: EligibleLead[] = [];
  const skipped: Array<{ lead: Lead; reason: string }> = [];
  for (const lead of qualified) {
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
    if (!opts.refresh && existing[lead.id] && existing[lead.id].length > 0) {
      skipped.push({ lead, reason: 'already_in_out_file' });
      continue;
    }
    const websiteUrlFact = await factsRepo.getCurrentFact(lead.id, 'official_website_url');
    eligible.push({ lead, domain: domainFact.value, baseUrl: resolveOfficialBaseUrl(domainFact.value, websiteUrlFact?.value ?? null) });
    if (eligible.length >= limit) break;
  }

  console.log(`\n=== discover-decision-makers (${opts.confirm ? 'LIVE --confirm' : opts.preview ? 'LIVE --preview (free, no LLM)' : 'PLAN'}) ===`);
  console.log(`  qualified leads scanned: ${String(qualified.length)}`);
  console.log(`  selected this run:       ${String(eligible.length)} (limit ${String(limit)})`);
  if (skipped.length > 0) {
    const byReason = new Map<string, number>();
    for (const s of skipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
    for (const [reason, n] of byReason) console.log(`  skipped (${reason}): ${String(n)}`);
  }

  if (!live) {
    for (const { lead, domain, baseUrl } of eligible) console.log(`  lead ${lead.id} → domain ${domain} → would fetch ${baseUrl}`);
    console.log('\n  PLAN mode: no fetch, no LLM call, nothing written. Re-run with --preview (free) or --confirm.');
    return;
  }

  // Global DRY_RUN kill switch: a live fetch to a third-party site is a live network call, same as the
  // paid LLM step — blocked up front, before any lead is touched, exactly like every other live path.
  assertLiveCallsAllowed(c.DRY_RUN, 'discover-decision-makers-fetch');

  const fetcher = (deps.buildFetcher ?? defaultBuildFetcher)(ctx);
  const llmDeps = opts.confirm ? (deps.buildLlmDeps ?? buildDecisionMakerLlmDeps)(ctx) : null;

  let llmCallsThisRun = 0;
  console.log('');
  for (const { lead, domain, baseUrl } of eligible) {
    const { pages, fetchErrors, fetchCount, selection } = await gatherWebsiteEvidence(fetcher, baseUrl, c.DISCOVER_DECISION_MAKERS_MAX_PAGES_PER_LEAD);
    const pageSummary = pages.map((p) => `${p.role}:${p.url}`).join(', ') || '(none)';
    if (!opts.confirm) {
      console.log(`  lead ${lead.id} → domain ${domain} → ${String(fetchCount)}/${String(c.DISCOVER_DECISION_MAKERS_MAX_PAGES_PER_LEAD)} fetches → pages: ${pageSummary}${fetchErrors.length > 0 ? ` (errors: ${fetchErrors.join('; ')})` : ''}`);
      for (const line of selection) console.log(`      ${line}`);
      continue;
    }

    if (!llmDeps) continue; // unreachable: opts.confirm true implies llmDeps was built above
    if (llmCallsThisRun >= c.MAX_LLM_CALLS_PER_RUN) {
      console.log(`  lead ${lead.id} → run-wide LLM call budget reached (${String(llmCallsThisRun)}/${String(c.MAX_LLM_CALLS_PER_RUN)}); remaining leads untouched.`);
      break;
    }
    llmCallsThisRun += 1;
    const result = await extractDecisionMakers(llmDeps, pages, lead.businessName, c.DISCOVER_DECISION_MAKERS_MAX_PAGES_PER_LEAD);

    if (result.status === 'ok') {
      console.log(
        `  lead ${lead.id} → domain ${domain} → pages: ${pageSummary} → accepted: ${result.accepted.map((a) => `${a.fullName} (${a.title}, tier ${String(a.priority)})`).join(', ') || 'none'} → rejected: ${result.rejected.map((r) => `${r.fullName}[${r.reason}]`).join(', ') || 'none'} (cost $${result.costUsd.toFixed(4)})`,
      );
      if (result.accepted.length > 0) {
        existing[lead.id] = result.accepted.map((a) => ({
          fullName: a.fullName, title: a.title, sourceUrl: a.sourceUrl, evidenceSnippet: a.evidenceSnippet, confidence: a.confidence,
        }));
        saveCandidatesFile(outPath, existing);
      }
    } else {
      console.log(`  lead ${lead.id} → domain ${domain} → ${result.status}${'message' in result ? `: ${result.message}` : ''}${'errors' in result ? `: ${result.errors.join('; ')}` : ''}`);
    }
  }

  console.log(`\n  wrote: ${outPath}`);
  console.log('  No Instantly/Hunter/Apollo/email-enrichment call was made. No lead_facts written. No lead state changed.');
}
