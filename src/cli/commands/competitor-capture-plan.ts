import { CANDIDATE_PATH_MATCHERS } from '../../domain/competitor/capture-constants.js';
import { evaluateEligibility } from '../../domain/competitor/capture-eligibility.js';
import { type CliContext } from '../context.js';
import { buildCaptureConfig, getProspectDomain, resolveResearchRun } from './competitor-capture-build.js';

export interface CompetitorCapturePlanOptions {
  lead?: string;
  researchRun?: string;
}

/**
 * Phase 7A2 read-only plan: validate the research run, selected competitors, origins, limits, and
 * provider mode; show the proposed pages and request bounds. Performs NO network request and NO
 * database write.
 */
export async function competitorCapturePlanCommand(ctx: CliContext, opts: CompetitorCapturePlanOptions): Promise<void> {
  if (!opts.lead) {
    console.error('Provide --lead <lead-id>.');
    process.exitCode = 1;
    return;
  }
  const lead = await ctx.leads.getById(opts.lead);
  if (!lead) {
    console.error(`Lead not found: ${opts.lead}`);
    process.exitCode = 1;
    return;
  }
  const resolved = await resolveResearchRun(ctx, opts.lead, opts.researchRun);
  if (!resolved) {
    console.error('No persisted competitor-research run found for this lead. Run competitor-research-run --apply first.');
    process.exitCode = 1;
    return;
  }
  const config = buildCaptureConfig(ctx.config);
  const prospectDomain = await getProspectDomain(ctx, opts.lead);
  const eligibility = resolved.competitors.map((c) => evaluateEligibility(c, prospectDomain));

  const liveMode = ctx.config.COMPETITOR_CAPTURE_PROVIDER === 'playwright';
  console.log(`\nCompetitor capture PLAN (read-only) — lead ${lead.id}`);
  console.log(`  research run: ${resolved.runId} (v${String(resolved.version)}, outcome ${resolved.outcome})`);
  console.log(`  provider mode: ${liveMode ? 'playwright (LIVE — requires COMPETITOR_CAPTURE_ENABLED + --confirm-live-capture)' : 'fixture (offline default)'}`);
  console.log(`  bounds: maxPages=${String(config.maxPages)} maxDepth=${String(config.maxDepth)} timeoutMs=${String(config.navigationTimeoutMs)} maxAgeDays=${String(config.maxAgeDays)}`);
  console.log(`  profiles: desktop + mobile; same-origin only; no forms, no login/payment, no sitemap crawl`);

  console.log(`\n  Selected competitors (${String(resolved.competitors.length)}):`);
  if (resolved.competitors.length === 0) console.log('    (none — nothing eligible to capture)');
  for (const e of eligibility) {
    if (e.eligible) {
      console.log(`    ✓ ${e.normalizedOrigin ?? ''} → origin ${e.originUrl ?? ''}`);
    } else {
      console.log(`    ✗ candidate ${e.competitorCandidateId} — INELIGIBLE (${e.reason ?? ''})`);
    }
  }

  console.log('\n  Proposed public page shapes (same-origin, bounded):');
  console.log('    - homepage (verified origin)');
  for (const m of CANDIDATE_PATH_MATCHERS) console.log(`    - ${m.role} (matched from homepage nav only)`);
  console.log('\n  No network request or database write was performed.');
}
