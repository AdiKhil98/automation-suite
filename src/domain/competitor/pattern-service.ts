/**
 * Phase 7A3A competitor pattern package service. Builds an immutable, versioned, source-traceable
 * package from ONE prospect + ONE approved research/capture set, deterministically and idempotently.
 * A dry build performs zero writes; an apply persists a DRAFT package inside a single transaction,
 * superseding prior DRAFT packages (never deleting). NO AI, NO network, NO email, NO Gmail/Sheets, NO
 * sending. Generation NEVER auto-approves — approval is a separate, explicit operator action.
 */

import { randomUUID } from 'node:crypto';
import { POSITIVE_PATTERN_RESULTS, COMPETITOR_PATTERN_RULES_VERSION, type PatternConfidence } from './pattern-constants.js';
import { computePatterns } from './pattern-logic.js';
import { patternConfigHash, patternInputHash, patternPackageHash } from './pattern-hash.js';
import { validatePackage, type ValidationResult } from './pattern-validator.js';
import {
  type CompetitorPattern,
  type CompetitorPatternPackage,
  type PatternBuildInput,
  type PatternRunResult,
  type ProspectContrast,
} from './pattern-types.js';

export interface NewPatternPackageRow {
  id: string;
  leadId: string;
  researchRunId: string;
  status: 'DRAFT';
  version: number;
  inputHash: string;
  configHash: string;
  packageHash: string;
  rulesVersion: string;
  confidence: PatternConfidence;
  freshnessEvaluatedAt: Date;
  selectedCompetitorIds: string[];
  captureRunIds: string[];
  eligibleEvidenceCount: number;
  excludedEvidenceCount: number;
  exclusions: CompetitorPatternPackage['exclusions'];
  prohibitedClaims: string[];
}

export interface NewPatternRow {
  id: string;
  packageId: string;
  pattern: CompetitorPattern;
}

export interface NewContrastRow {
  id: string;
  packageId: string;
  patternId: string | null;
  contrast: ProspectContrast;
}

export interface NewPatternEvidenceRefRow {
  id: string;
  packageId: string;
  ref: CompetitorPatternPackage['evidenceRefs'][number];
}

export interface CompetitorPatternStore {
  findPackageByHashes(leadId: string, inputHash: string, configHash: string): Promise<{ id: string; version: number; status: string } | null>;
  maxVersionForLead(leadId: string): Promise<number>;
  supersedePriorDraftPackages(leadId: string, newPackageId: string): Promise<void>;
  insertPackage(row: NewPatternPackageRow): Promise<void>;
  insertPatterns(rows: NewPatternRow[]): Promise<void>;
  insertContrasts(rows: NewContrastRow[]): Promise<void>;
  insertEvidenceRefs(rows: NewPatternEvidenceRefRow[]): Promise<void>;
}

export interface CompetitorPatternUnitOfWork {
  transaction<T>(fn: (repos: { pattern: CompetitorPatternStore }) => Promise<T>): Promise<T>;
}

export interface PatternServiceDeps {
  uow: CompetitorPatternUnitOfWork;
}

export interface BuildResult {
  package: CompetitorPatternPackage;
  validation: ValidationResult;
}

/** The strongest confidence among positive (approvable-shape) patterns; LOW when there are none. */
function packageConfidence(patterns: CompetitorPattern[]): PatternConfidence {
  let best: PatternConfidence = 'LOW';
  for (const p of patterns) {
    if (p.isDepth || !POSITIVE_PATTERN_RESULTS.has(p.result)) continue;
    if (p.confidence === 'HIGH') return 'HIGH';
    if (p.confidence === 'MEDIUM') best = 'MEDIUM';
  }
  return best;
}

export class CompetitorPatternService {
  constructor(private readonly deps: PatternServiceDeps) {}

  /** Pure, deterministic build (no persistence). Also runs the hard validator. */
  build(input: PatternBuildInput): BuildResult {
    const computation = computePatterns(input);
    const eligibleEvidenceCount = computation.eligibleEvidenceIds.length;
    const excludedEvidenceCount = computation.exclusions.length;

    const inputHash = patternInputHash(input, computation.eligibleEvidenceIds);
    const configHash = patternConfigHash(COMPETITOR_PATTERN_RULES_VERSION, input.maxAgeDays);
    const packageHash = patternPackageHash(computation.patterns, computation.contrasts, COMPETITOR_PATTERN_RULES_VERSION);

    const selectedCompetitorIds = input.competitors.filter((c) => c.selected).map((c) => c.competitorCandidateId).sort();

    const pkg: CompetitorPatternPackage = {
      leadId: input.leadId,
      researchRunId: input.researchRunId,
      captureRunIds: [...input.captureRunIds].sort(),
      selectedCompetitorIds,
      eligibleEvidenceCount,
      excludedEvidenceCount,
      exclusions: computation.exclusions,
      patterns: computation.patterns,
      contrasts: computation.contrasts,
      evidenceRefs: computation.evidenceRefs,
      confidence: packageConfidence(computation.patterns),
      freshnessEvaluatedAt: input.now,
      rulesVersion: COMPETITOR_PATTERN_RULES_VERSION,
      inputHash,
      configHash,
      packageHash,
      prohibitedClaims: [],
      status: 'DRAFT',
    };

    const validation = validatePackage(pkg, input.competitors.filter((c) => c.selected).map((c) => c.businessName ?? c.parentBrand));
    pkg.prohibitedClaims = validation.prohibitedClaims;

    return { package: pkg, validation };
  }

  /**
   * Build and (when `apply`) persist. Persisting an identical (leadId, inputHash, configHash) reuses
   * the existing package version — never a duplicate. A materially different eligible evidence set
   * changes the input hash → a new immutable version, superseding prior DRAFT packages.
   */
  async run(input: PatternBuildInput, apply: boolean): Promise<PatternRunResult & { validation: ValidationResult }> {
    const { package: pkg, validation } = this.build(input);

    if (!apply) {
      return { package: pkg, validation, version: null, packageRecordId: null, persisted: false, reusedExisting: false };
    }

    const result = await this.deps.uow.transaction(async ({ pattern }) => {
      const existing = await pattern.findPackageByHashes(pkg.leadId, pkg.inputHash, pkg.configHash);
      if (existing) {
        return { package: pkg, version: existing.version, packageRecordId: existing.id, persisted: false, reusedExisting: true };
      }
      const packageId = randomUUID();
      const version = (await pattern.maxVersionForLead(pkg.leadId)) + 1;
      await pattern.supersedePriorDraftPackages(pkg.leadId, packageId);
      await pattern.insertPackage({
        id: packageId,
        leadId: pkg.leadId,
        researchRunId: pkg.researchRunId,
        status: 'DRAFT',
        version,
        inputHash: pkg.inputHash,
        configHash: pkg.configHash,
        packageHash: pkg.packageHash,
        rulesVersion: pkg.rulesVersion,
        confidence: pkg.confidence,
        freshnessEvaluatedAt: pkg.freshnessEvaluatedAt,
        selectedCompetitorIds: pkg.selectedCompetitorIds,
        captureRunIds: pkg.captureRunIds,
        eligibleEvidenceCount: pkg.eligibleEvidenceCount,
        excludedEvidenceCount: pkg.excludedEvidenceCount,
        exclusions: pkg.exclusions,
        prohibitedClaims: pkg.prohibitedClaims,
      });
      const patternRows: NewPatternRow[] = pkg.patterns.map((p) => ({ id: randomUUID(), packageId, pattern: p }));
      const patternIdByCategory = new Map(patternRows.map((r) => [r.pattern.category, r.id]));
      await pattern.insertPatterns(patternRows);
      await pattern.insertContrasts(
        pkg.contrasts.map((c) => ({ id: randomUUID(), packageId, contrast: c, patternId: patternIdByCategory.get(c.category) ?? null })),
      );
      await pattern.insertEvidenceRefs(pkg.evidenceRefs.map((ref) => ({ id: randomUUID(), packageId, ref })));
      return { package: pkg, version, packageRecordId: packageId, persisted: true, reusedExisting: false };
    });

    return { ...result, validation };
  }
}
