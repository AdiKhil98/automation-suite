import { eq, inArray } from 'drizzle-orm';
import { type EvidenceCategory } from '../../domain/competitor/evidence-types.js';
import { evaluateFreshness } from '../../domain/competitor/evidence-freshness.js';
import { supportingEvidenceFailure } from '../../domain/competitor/pattern-eligibility.js';
import {
  type PatternConfidence,
} from '../../domain/competitor/pattern-constants.js';
import {
  type CompetitorPattern,
  type CompetitorPatternPackage,
  type PatternBuildInput,
  type PatternCompetitorInput,
  type PatternEvidenceItem,
  type ProspectContrast,
  type ProspectEvidenceInput,
} from '../../domain/competitor/pattern-types.js';
import { AuditInputRepository } from '../../persistence/repositories/audit-input.repo.js';
import { CompetitorCaptureRepository } from '../../persistence/repositories/competitor-capture.repo.js';
import { CompetitorResearchRepository } from '../../persistence/repositories/competitor-research.repo.js';
import { CompetitorPatternRepository } from '../../persistence/repositories/competitor-pattern.repo.js';
import { competitorCaptureRuns, competitorEvidenceItems, competitorPatternPackages, websiteCaptureRuns } from '../../persistence/schema.js';
import { type CliContext } from '../context.js';

export interface ResolvedPatternInput {
  input: PatternBuildInput;
  researchRunId: string;
  captureRunId: string;
  selectedCount: number;
}

/** Map a persisted competitor evidence row to the flat pattern-evidence shape. */
function toPatternEvidenceItem(row: {
  id: string;
  captureRunId: string;
  competitorCandidateId: string;
  evidenceCategory: string;
  observationKind: string;
  confidence: string;
  freshnessStatus: string;
  safeForOutreach: boolean;
  active: boolean;
  sourcePageUrl: string;
  numericValue: number | null;
  capturedAt: Date;
}): PatternEvidenceItem {
  return {
    id: row.id,
    captureRunId: row.captureRunId,
    competitorCandidateId: row.competitorCandidateId,
    evidenceCategory: row.evidenceCategory as EvidenceCategory,
    observationKind: row.observationKind,
    confidence: row.confidence as PatternConfidence,
    storedFreshness: row.freshnessStatus,
    safeForOutreach: row.safeForOutreach,
    active: row.active,
    sourcePageUrl: row.sourcePageUrl,
    numericValue: row.numericValue,
    capturedAt: row.capturedAt,
    // Phase 7A2 stores ONLY positive presence facts (no explicit negatives), so every live item is
    // PRESENT with no inspection scope. Absence therefore stays UNKNOWN — never inferred here.
    polarity: 'PRESENT',
    inspectionScope: null,
  };
}

/** Resolve the prospect's OWN verified capture evidence (source-traceable, deterministic). */
async function resolveProspectEvidence(ctx: CliContext, leadId: string): Promise<ProspectEvidenceInput> {
  const audit = new AuditInputRepository(ctx.db);
  const cap = await audit.latestAuditCapture(leadId);
  if (!cap) return { leadId, captureRunId: null, capturedAt: null, capturedOk: false, refs: [], negatives: [] };
  const runRow = (
    await ctx.db
      .select({ startedAt: websiteCaptureRuns.startedAt, completedAt: websiteCaptureRuns.completedAt })
      .from(websiteCaptureRuns)
      .where(eq(websiteCaptureRuns.id, cap.captureRunId))
      .limit(1)
  )[0];
  const capturedAt = runRow?.completedAt ?? runRow?.startedAt ?? null;
  return {
    leadId,
    captureRunId: cap.captureRunId,
    capturedAt,
    capturedOk: true,
    refs: cap.evidence.map((e) => ({ id: e.id, evidenceType: e.evidenceType, sourceUrl: e.sourceUrl, normalizedValue: e.normalizedValue, profile: e.profile })),
    // Phase 5 prospect capture stores only positive primitives — no explicit verified negatives — so
    // a missing primitive is NEVER treated as absence. Contrasts stay withheld (UNKNOWN) until an
    // explicit-negative prospect capability exists.
    negatives: [],
  };
}

/**
 * Assemble the deterministic pattern build input from persisted Phase 7A1 (research) + 7A2 (capture)
 * data + the prospect's own verified capture evidence. Read-only. Returns a human-readable error
 * string when a required prerequisite is missing. Never touches the network, AI, Gmail, or Sheets.
 */
export async function resolvePatternInput(
  ctx: CliContext,
  leadId: string,
  opts: { researchRun?: string; captureRun?: string },
): Promise<ResolvedPatternInput | { error: string }> {
  const research = new CompetitorResearchRepository(ctx.db);
  const runs = await research.listRunsForLead(leadId);
  const researchRun = opts.researchRun ? runs.find((r) => r.id === opts.researchRun) : runs.find((r) => r.status === 'DRAFT');
  if (!researchRun) return { error: 'No persisted competitor-research run found. Run competitor-research-run --apply first.' };

  const candidates = (await research.getCandidates(researchRun.id)).filter((c) => c.disposition === 'ACCEPTED');

  const captureRepo = new CompetitorCaptureRepository(ctx.db);
  const captureRuns = await captureRepo.listRunsForLead(leadId);
  const captureRun = opts.captureRun
    ? captureRuns.find((r) => r.id === opts.captureRun)
    : captureRuns.find((r) => r.researchRunId === researchRun.id && r.status === 'DRAFT');
  if (!captureRun) return { error: 'No active competitor capture run found for this research run. Run competitor-capture-run --apply first.' };

  const evidence = await captureRepo.getEvidence(captureRun.id);
  const pages = await captureRepo.getPages(captureRun.id);
  const capturedOk = new Set(pages.filter((p) => p.ok).map((p) => p.competitorCandidateId));
  const evidenceByCandidate = new Map<string, typeof evidence>();
  for (const e of evidence) {
    const list = evidenceByCandidate.get(e.competitorCandidateId) ?? [];
    list.push(e);
    evidenceByCandidate.set(e.competitorCandidateId, list);
  }

  const competitors: PatternCompetitorInput[] = candidates.map((c) => ({
    competitorCandidateId: c.id,
    brandKey: c.brandKey,
    businessName: c.businessName,
    parentBrand: c.parentBrand,
    selected: true,
    captureActive: captureRun.status === 'DRAFT',
    capturedOk: capturedOk.has(c.id),
    evidence: (evidenceByCandidate.get(c.id) ?? []).map(toPatternEvidenceItem),
  }));

  const prospect = await resolveProspectEvidence(ctx, leadId);

  const input: PatternBuildInput = {
    leadId,
    researchRunId: researchRun.id,
    captureRunIds: [captureRun.id],
    competitors,
    prospect,
    now: new Date(),
    maxAgeDays: ctx.config.COMPETITOR_EVIDENCE_MAX_AGE_DAYS,
  };
  return { input, researchRunId: researchRun.id, captureRunId: captureRun.id, selectedCount: competitors.length };
}

/**
 * Reconstruct a full package contract from persisted rows so the approval workflow can RE-VALIDATE the
 * exact stored package (defense in depth). Returns null when the package is missing.
 */
export async function reconstructPackage(
  ctx: CliContext,
  packageId: string,
): Promise<{ pkg: CompetitorPatternPackage; competitorNames: (string | null)[]; row: typeof competitorPatternPackages.$inferSelect } | null> {
  const repo = new CompetitorPatternRepository(ctx.db);
  const row = await repo.getPackage(packageId);
  if (!row) return null;
  const patternRows = await repo.getPatterns(packageId);
  const contrastRows = await repo.getContrasts(packageId);
  const refRows = await repo.getEvidenceRefs(packageId);

  const patterns: CompetitorPattern[] = patternRows.map((p) => ({
    category: p.category as EvidenceCategory,
    result: p.result as CompetitorPattern['result'],
    presentCount: p.presentCount,
    absentCount: p.absentCount,
    unknownCount: p.unknownCount,
    usableDenominator: p.usableDenominator,
    totalSelected: p.totalSelected,
    participatingCompetitorIds: (p.participatingCompetitorIds as string[]) ?? [],
    evidenceItemIds: (p.evidenceItemIds as string[]) ?? [],
    confidence: p.confidence as PatternConfidence,
    wordingForm: p.wordingForm as CompetitorPattern['wordingForm'],
    wordingText: p.wordingText,
    consequenceLabel: p.consequenceLabel as CompetitorPattern['consequenceLabel'],
    numericMedian: p.numericMedian,
    numericValues: (p.numericValues as number[]) ?? [],
    isDepth: p.isDepth,
  }));

  const contrasts: ProspectContrast[] = contrastRows.map((c) => ({
    category: c.category as EvidenceCategory,
    contrastKind: 'BOOLEAN',
    prospectState: 'ABSENT',
    prospectEvidenceRef: c.prospectEvidenceRef,
    confidence: c.confidence as PatternConfidence,
    consequenceLabel: c.consequenceLabel as ProspectContrast['consequenceLabel'],
  }));

  const pkg: CompetitorPatternPackage = {
    leadId: row.leadId,
    researchRunId: row.researchRunId,
    captureRunIds: (row.captureRunIds as string[]) ?? [],
    selectedCompetitorIds: (row.selectedCompetitorIds as string[]) ?? [],
    eligibleEvidenceCount: row.eligibleEvidenceCount,
    excludedEvidenceCount: row.excludedEvidenceCount,
    exclusions: (row.exclusionReasons as CompetitorPatternPackage['exclusions']) ?? [],
    patterns,
    contrasts,
    evidenceRefs: refRows.map((r) => ({
      kind: r.kind as 'COMPETITOR' | 'PROSPECT',
      evidenceItemId: r.evidenceItemId,
      captureRunId: r.captureRunId,
      competitorCandidateId: r.competitorCandidateId,
      category: r.category as EvidenceCategory | null,
      sourceUrl: r.sourceUrl,
    })),
    confidence: row.confidence as PatternConfidence,
    freshnessEvaluatedAt: row.freshnessEvaluatedAt,
    rulesVersion: row.rulesVersion,
    inputHash: row.inputHash,
    configHash: row.configHash,
    packageHash: row.packageHash,
    prohibitedClaims: (row.prohibitedClaims as string[]) ?? [],
    status: row.status as CompetitorPatternPackage['status'],
  };

  const research = new CompetitorResearchRepository(ctx.db);
  const candidates = await research.getCandidates(row.researchRunId);
  const selected = new Set(pkg.selectedCompetitorIds);
  const competitorNames = candidates.filter((c) => selected.has(c.id)).map((c) => c.businessName ?? c.parentBrand);

  return { pkg, competitorNames, row };
}

/**
 * Re-evaluate, against LIVE database state at `now`, every piece of evidence a package depends on.
 * Returns a list of failure reasons — empty means all supporting evidence is still active, safe, and
 * FRESH and every owning capture run is still active (not superseded). Used at review (display) and at
 * approval (BLOCK): an APPROVED transition must fail if evidence went stale/superseded/invalidated/
 * unsafe after the DRAFT package was created. The package's stored generation-time freshness is never
 * trusted on its own.
 */
export async function recheckSupportingEvidence(ctx: CliContext, pkg: CompetitorPatternPackage, now: Date): Promise<string[]> {
  const failures: string[] = [];
  const maxAgeDays = ctx.config.COMPETITOR_EVIDENCE_MAX_AGE_DAYS;

  const competitorEvidenceIds = pkg.evidenceRefs.filter((r) => r.kind === 'COMPETITOR').map((r) => r.evidenceItemId);
  if (competitorEvidenceIds.length > 0) {
    const items = await ctx.db
      .select({
        id: competitorEvidenceItems.id,
        active: competitorEvidenceItems.active,
        safeForOutreach: competitorEvidenceItems.safeForOutreach,
        capturedAt: competitorEvidenceItems.capturedAt,
        captureRunId: competitorEvidenceItems.captureRunId,
        captureStatus: competitorCaptureRuns.status,
      })
      .from(competitorEvidenceItems)
      .leftJoin(competitorCaptureRuns, eq(competitorEvidenceItems.captureRunId, competitorCaptureRuns.id))
      .where(inArray(competitorEvidenceItems.id, competitorEvidenceIds));
    const byId = new Map(items.map((i) => [i.id, i]));
    for (const id of competitorEvidenceIds) {
      const item = byId.get(id);
      if (!item) { failures.push(`competitor evidence ${id} no longer exists`); continue; }
      const failure = supportingEvidenceFailure(
        { evidenceItemId: id, active: item.active, safeForOutreach: item.safeForOutreach, capturedAt: item.capturedAt, captureActive: item.captureStatus === 'DRAFT' },
        now,
        maxAgeDays,
      );
      if (failure) failures.push(failure);
    }
  }

  // Prospect contrasts (if any) require the prospect capture to still be present + fresh.
  if (pkg.contrasts.length > 0) {
    const prospectEvidence = await resolveProspectEvidence(ctx, pkg.leadId);
    if (!prospectEvidence.captureRunId || !prospectEvidence.capturedOk) {
      failures.push('prospect capture backing the contrast(s) is no longer available');
    } else if (prospectEvidence.capturedAt && evaluateFreshness(prospectEvidence.capturedAt, now, maxAgeDays) !== 'FRESH') {
      failures.push('prospect capture backing the contrast(s) is now stale');
    }
  }

  return failures;
}
