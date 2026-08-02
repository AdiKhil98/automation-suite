import { CompetitorPatternRepository } from '../../persistence/repositories/competitor-pattern.repo.js';
import { type CliContext } from '../context.js';
import { reconstructPackage, recheckSupportingEvidence } from './competitor-pattern-build.js';

export interface CompetitorPatternReviewOptions {
  lead?: string;
  package?: string;
}

/**
 * Phase 7A3A read-only review of persisted competitor pattern packages for a lead: status, confidence,
 * exact counts, every competitor + prospect evidence source, exclusions + reasons, contrasts, and
 * withheld reasons. No comparative email wording is produced; nothing is written.
 */
export async function competitorPatternReviewCommand(ctx: CliContext, opts: CompetitorPatternReviewOptions): Promise<void> {
  if (!opts.lead) {
    console.error('Provide --lead <lead-id>.');
    process.exitCode = 1;
    return;
  }
  const repo = new CompetitorPatternRepository(ctx.db);
  const packages = await repo.listPackagesForLead(opts.lead);
  const selected = opts.package ? packages.filter((p) => p.id === opts.package) : packages;
  if (selected.length === 0) {
    console.log(`No competitor pattern packages found for lead ${opts.lead}.`);
    return;
  }

  for (const pkg of selected) {
    console.log(`\n=== Package ${pkg.id} (v${String(pkg.version)}) — status ${pkg.status} ===`);
    console.log(`  lead ${pkg.leadId}  research run ${pkg.researchRunId}`);
    console.log(`  confidence: ${pkg.confidence}  eligible: ${String(pkg.eligibleEvidenceCount)}  excluded: ${String(pkg.excludedEvidenceCount)}`);
    console.log(`  packageHash: ${pkg.packageHash.slice(0, 12)}  freshnessEvaluatedAt: ${pkg.freshnessEvaluatedAt.toISOString()}`);
    if (pkg.approvedBy) console.log(`  APPROVED by ${pkg.approvedBy} at ${pkg.approvedAt?.toISOString() ?? ''}`);
    if (pkg.rejectedBy) console.log(`  REJECTED by ${pkg.rejectedBy} at ${pkg.rejectedAt?.toISOString() ?? ''}`);
    if (pkg.invalidatedBy) console.log(`  INVALIDATED by ${pkg.invalidatedBy} at ${pkg.invalidatedAt?.toISOString() ?? ''}`);
    const prohibited = (pkg.prohibitedClaims as string[]) ?? [];
    console.log(`  prohibited-claim validation: ${prohibited.length === 0 ? 'clean' : `BLOCKED (${prohibited.join(', ')})`}`);

    const patterns = await repo.getPatterns(pkg.id);
    console.log('\n  Patterns:');
    for (const p of patterns) {
      const tag = p.isDepth ? ' [depth]' : '';
      console.log(`    ${p.category}${tag}: present=${String(p.presentCount)} absent=${String(p.absentCount)} unknown=${String(p.unknownCount)} denom=${String(p.usableDenominator)} → ${p.result} (${p.confidence})`);
      if (p.wordingText) console.log(`        wording: "${p.wordingText}"  consequence: ${p.consequenceLabel ?? ''}`);
      if (p.isDepth && p.numericMedian !== null) console.log(`        median depth: ${String(p.numericMedian)}  values: [${(p.numericValues as number[]).join(', ')}]`);
      const ids = (p.evidenceItemIds as string[]) ?? [];
      if (ids.length > 0) console.log(`        evidence: ${ids.join(', ')}`);
    }

    const contrasts = await repo.getContrasts(pkg.id);
    console.log('\n  Prospect contrasts:');
    if (contrasts.length === 0) console.log('    (none)');
    for (const c of contrasts) console.log(`    ${c.category} — prospect ${c.prospectState} (${c.confidence}) → ${c.consequenceLabel}  [prospect ref ${c.prospectEvidenceRef}]`);

    const refs = await repo.getEvidenceRefs(pkg.id);
    console.log('\n  Evidence sources:');
    for (const r of refs) console.log(`    [${r.kind}] ${r.evidenceItemId}  ${r.category ?? ''}  ${r.sourceUrl ?? ''}`);

    const exclusions = (pkg.exclusionReasons as Array<{ evidenceItemId: string; category: string | null; reason: string }>) ?? [];
    console.log('\n  Excluded evidence:');
    if (exclusions.length === 0) console.log('    (none)');
    for (const e of exclusions) console.log(`    ${e.evidenceItemId} (${e.category ?? ''}) — ${e.reason}`);

    // Re-evaluate supporting evidence against LIVE state NOW (freshness is never trusted from storage).
    const reconstructed = await reconstructPackage(ctx, pkg.id);
    if (reconstructed) {
      const failures = await recheckSupportingEvidence(ctx, reconstructed.pkg, new Date());
      console.log('\n  Approval-time freshness (re-evaluated now):');
      if (failures.length === 0) console.log('    ✓ all supporting evidence still active, safe, and FRESH');
      else for (const f of failures) console.log(`    ✗ ${f} (would BLOCK approval)`);
    }
  }
  console.log('\n  Read-only review. No email wording produced, no writes performed.');
}
