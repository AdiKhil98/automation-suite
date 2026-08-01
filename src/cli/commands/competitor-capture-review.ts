import { evaluateFreshness } from '../../domain/competitor/evidence-freshness.js';
import { CompetitorCaptureRepository } from '../../persistence/repositories/competitor-capture.repo.js';
import { type CliContext } from '../context.js';

export interface CompetitorCaptureReviewOptions {
  lead?: string;
}

/**
 * Phase 7A2 read-only review: display persisted capture runs for a lead — source pages, evidence
 * items, confidence, freshness, and withholding reasons. Freshness is RE-EVALUATED against the max-age
 * window at review time, so an item that has aged past 30 days is shown STALE even if stored FRESH.
 * No comparative pattern, no email wording, no external access.
 */
export async function competitorCaptureReviewCommand(ctx: CliContext, opts: CompetitorCaptureReviewOptions): Promise<void> {
  if (!opts.lead) {
    console.error('Provide --lead <lead-id>.');
    process.exitCode = 1;
    return;
  }
  const repo = new CompetitorCaptureRepository(ctx.db);
  const runs = await repo.listRunsForLead(opts.lead);
  if (runs.length === 0) {
    console.log(`No competitor capture runs for lead ${opts.lead}.`);
    return;
  }
  const now = new Date();
  const maxAge = ctx.config.COMPETITOR_EVIDENCE_MAX_AGE_DAYS;

  for (const run of runs) {
    console.log(`\nCapture run ${run.id} (v${String(run.version)}) — ${run.status}`);
    console.log(`  method=${run.method} provider=${run.provider} outcome=${run.outcome} rules=${run.rulesVersion}`);
    console.log(`  competitors=${String(run.competitorCount)} pages=${String(run.pageCount)} evidence=${String(run.evidenceCount)} (active ${String(run.activeEvidenceCount)}, withheld ${String(run.withheldEvidenceCount)})`);
    console.log(`  capturedAt=${run.completedAt.toISOString()} contentHash=${run.contentHash.slice(0, 12)}`);

    const pages = await repo.getPages(run.id);
    console.log(`  Source pages (${String(pages.length)}):`);
    for (const p of pages) {
      console.log(`    [${p.profile}] ${p.role} — ${p.finalUrl} ok=${String(p.ok)}${p.ok ? '' : ` (${JSON.stringify(p.errorKinds)})`}`);
    }

    const evidence = await repo.getEvidence(run.id);
    console.log(`  Evidence items (${String(evidence.length)}):`);
    for (const e of evidence) {
      const liveFreshness = e.active ? evaluateFreshness(e.capturedAt, now, maxAge) : e.freshnessStatus;
      const flags = `conf=${e.confidence} fresh=${liveFreshness} safe=${String(e.safeForOutreach && liveFreshness === 'FRESH')} active=${String(e.active)}`;
      console.log(`    ${e.evidenceCategory} (${e.profile}) [${e.observationKind}] — ${flags}`);
      console.log(`        ${e.observation}`);
      console.log(`        src=${e.sourcePageUrl} selector=${e.selector ?? '—'}${e.withholdingReason ? ` withheld=${e.withholdingReason}` : ''}`);
    }
  }
  console.log('\n(Read-only. No comparative pattern, prospect-vs-competitor statement, or email wording exists yet — that is Phase 7A3.)');
}
