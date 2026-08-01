import { CompetitorResearchRepository } from '../../persistence/repositories/competitor-research.repo.js';
import { type CliContext } from '../context.js';

export interface CompetitorResearchReviewOptions {
  lead?: string;
}

/**
 * Read-only review of the persisted competitor-research runs for a lead: the latest (DRAFT) run,
 * its selected competitors with scores, and every rejected candidate with its reason. Does NOT
 * approve anything for email use (email enrichment does not exist yet — that is Phase 7A3).
 */
export async function competitorResearchReviewCommand(ctx: CliContext, opts: CompetitorResearchReviewOptions): Promise<void> {
  if (!opts.lead) {
    console.error('Provide --lead <lead-id>.');
    process.exitCode = 1;
    return;
  }
  const repo = new CompetitorResearchRepository(ctx.db);
  const runs = await repo.listRunsForLead(opts.lead);
  if (runs.length === 0) {
    console.log(`No competitor-research runs found for lead ${opts.lead}.`);
    return;
  }

  const latest = runs[0];
  if (!latest) {
    console.log(`No competitor-research runs found for lead ${opts.lead}.`);
    return;
  }
  console.log(`\nCompetitor research review — lead ${opts.lead}`);
  console.log(`  runs on record: ${String(runs.length)} (versions ${runs.map((r) => `v${String(r.version)}:${r.status}`).join(', ')})`);
  console.log(`\n  Latest run ${latest.id} (v${String(latest.version)}, ${latest.status})`);
  console.log(`    provider: ${latest.provider}  outcome: ${latest.outcome}  activeRadius: ${latest.activeRadius}`);
  console.log(`    rulesVersion: ${latest.rulesVersion}  candidates: ${String(latest.candidateCount)}  accepted: ${String(latest.acceptedCount)}  rejected: ${String(latest.rejectedCount)}`);
  console.log(`    config: primary=${String(latest.primaryRadiusKm)}km fallback=${String(latest.fallbackRadiusKm)}km maxSelected=${String(latest.maxSelected)}`);

  const candidates = await repo.getCandidates(latest.id);
  const selected = candidates.filter((c) => c.disposition === 'ACCEPTED').sort((a, b) => (a.acceptanceRank ?? 0) - (b.acceptanceRank ?? 0));
  const rejected = candidates.filter((c) => c.disposition === 'REJECTED');

  console.log('\n  Selected competitors:');
  if (selected.length === 0) console.log('    (none)');
  for (const c of selected) {
    console.log(`    #${String(c.acceptanceRank ?? 0)} ${c.normalizedDomain ?? c.rawDomain ?? '(no domain)'} — score ${String(c.comparabilityScore ?? 0)} — ${c.categoryMatch ?? ''} — confidence ${c.confidence ?? ''}`);
    console.log(`        ${c.reasonDetail}`);
  }

  console.log('\n  Rejected candidates:');
  if (rejected.length === 0) console.log('    (none)');
  for (const c of rejected) {
    console.log(`    [row ${String(c.rowIndex)}] ${c.normalizedDomain ?? c.rawDomain ?? '(no domain)'} — ${c.rejectionReason ?? ''}: ${c.reasonDetail}`);
  }
  console.log('\n  (Review only — no evidence capture or email enrichment exists in Phase 7A1.)');
}
