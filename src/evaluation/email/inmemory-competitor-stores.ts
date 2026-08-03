/**
 * Phase 7A4A — in-memory adapters implementing the SAME production ports the Phase 7A1/7A2/7A3A
 * services persist through. These let the offline validation harness drive the REAL domain services
 * (research selection, capture evidence rules, pattern generation, package validation + approval)
 * through a genuine persist → read-back cycle without any database, network, or production write.
 *
 * NOTHING here re-implements domain logic: the services own all arithmetic, thresholds, dedup, hashing,
 * and validation. These classes only store rows in Maps and hand them back, exactly like the drizzle
 * repositories do — so the harness cannot "cheat" by hand-building a final approved package.
 */

import {
  type CompetitorResearchStore,
  type CompetitorResearchUnitOfWork,
  type ExistingRunRef,
  type NewCompetitorCandidate,
  type NewCompetitorResearchRun,
} from '../../domain/competitor/research-service.js';
import {
  type CompetitorCaptureStore,
  type CompetitorCaptureUnitOfWork,
  type NewCompetitorCaptureRun,
  type NewCompetitorCapturedPage,
} from '../../domain/competitor/capture-service.js';
import { type CompetitorEvidenceItem } from '../../domain/competitor/evidence-types.js';
import {
  type CompetitorPatternStore,
  type CompetitorPatternUnitOfWork,
  type NewContrastRow,
  type NewPatternEvidenceRefRow,
  type NewPatternPackageRow,
  type NewPatternRow,
} from '../../domain/competitor/pattern-service.js';
import { type PackageStatus } from '../../domain/competitor/pattern-constants.js';

/** In-memory Phase 7A1 research store + its own single-connection unit of work. */
export class InMemoryResearchStore implements CompetitorResearchStore, CompetitorResearchUnitOfWork {
  private readonly runs: NewCompetitorResearchRun[] = [];
  private readonly candidates: NewCompetitorCandidate[] = [];

  async transaction<T>(fn: (repos: { research: CompetitorResearchStore }) => Promise<T>): Promise<T> {
    return fn({ research: this });
  }

  async findRunByHashes(leadId: string, inputHash: string, configHash: string): Promise<ExistingRunRef | null> {
    const r = this.runs.find((x) => x.leadId === leadId && x.inputHash === inputHash && x.configHash === configHash);
    return r ? { id: r.id, version: r.version, outcome: r.outcome, status: r.status } : null;
  }

  async maxVersionForLead(leadId: string): Promise<number> {
    return this.runs.filter((r) => r.leadId === leadId).reduce((m, r) => Math.max(m, r.version), 0);
  }

  async supersedePriorDraftRuns(leadId: string, newRunId: string): Promise<void> {
    for (const r of this.runs) {
      if (r.leadId === leadId && r.id !== newRunId && r.status === 'DRAFT') {
        (r as { status: string }).status = 'SUPERSEDED';
      }
    }
  }

  async insertRun(run: NewCompetitorResearchRun): Promise<void> {
    this.runs.push(run);
  }

  async insertCandidates(rows: NewCompetitorCandidate[]): Promise<void> {
    this.candidates.push(...rows);
  }

  /** Read-back (mirrors CompetitorResearchRepository.getCandidates). */
  getCandidates(researchRunId: string): NewCompetitorCandidate[] {
    return this.candidates.filter((c) => c.researchRunId === researchRunId);
  }
}

/** In-memory Phase 7A2 capture store + its own single-connection unit of work. */
export class InMemoryCaptureStore implements CompetitorCaptureStore, CompetitorCaptureUnitOfWork {
  private readonly runs: NewCompetitorCaptureRun[] = [];
  private readonly pages: NewCompetitorCapturedPage[] = [];
  private readonly evidence: CompetitorEvidenceItem[] = [];

  async transaction<T>(fn: (repos: { capture: CompetitorCaptureStore }) => Promise<T>): Promise<T> {
    return fn({ capture: this });
  }

  async findRunByContent(): Promise<{ id: string; version: number } | null> {
    return null;
  }

  async maxVersionForResearchRun(researchRunId: string): Promise<number> {
    return this.runs.filter((r) => r.researchRunId === researchRunId).reduce((m, r) => Math.max(m, r.version), 0);
  }

  async supersedePriorDraftRuns(researchRunId: string, newRunId: string): Promise<void> {
    for (const r of this.runs) {
      if (r.researchRunId === researchRunId && r.id !== newRunId && r.status === 'DRAFT') {
        (r as { status: string }).status = 'SUPERSEDED';
      }
    }
  }

  async insertRun(run: NewCompetitorCaptureRun): Promise<void> {
    this.runs.push(run);
  }

  async insertPages(rows: NewCompetitorCapturedPage[]): Promise<void> {
    this.pages.push(...rows);
  }

  async insertEvidence(rows: CompetitorEvidenceItem[]): Promise<void> {
    this.evidence.push(...rows);
  }

  getEvidence(captureRunId: string): CompetitorEvidenceItem[] {
    return this.evidence.filter((e) => e.captureRunId === captureRunId);
  }

  getPages(captureRunId: string): NewCompetitorCapturedPage[] {
    return this.pages.filter((p) => p.captureRunId === captureRunId);
  }
}

/** A persisted-in-memory pattern package with its child rows (mirrors the four 7A3A tables). */
export interface StoredPatternPackage {
  header: Omit<NewPatternPackageRow, 'status'> & { status: PackageStatus; approvedBy: string | null; approvedAt: Date | null };
  patterns: NewPatternRow[];
  contrasts: NewContrastRow[];
  evidenceRefs: NewPatternEvidenceRefRow[];
}

/** In-memory Phase 7A3A pattern store + its own single-connection unit of work. */
export class InMemoryPatternStore implements CompetitorPatternStore, CompetitorPatternUnitOfWork {
  private readonly packages = new Map<string, StoredPatternPackage>();

  async transaction<T>(fn: (repos: { pattern: CompetitorPatternStore }) => Promise<T>): Promise<T> {
    return fn({ pattern: this });
  }

  async findPackageByHashes(leadId: string, inputHash: string, configHash: string): Promise<{ id: string; version: number; status: string } | null> {
    for (const p of this.packages.values()) {
      if (p.header.leadId === leadId && p.header.inputHash === inputHash && p.header.configHash === configHash) {
        return { id: p.header.id, version: p.header.version, status: p.header.status };
      }
    }
    return null;
  }

  async maxVersionForLead(leadId: string): Promise<number> {
    let max = 0;
    for (const p of this.packages.values()) if (p.header.leadId === leadId) max = Math.max(max, p.header.version);
    return max;
  }

  async supersedePriorDraftPackages(leadId: string, newPackageId: string): Promise<void> {
    for (const p of this.packages.values()) {
      if (p.header.leadId === leadId && p.header.id !== newPackageId && p.header.status === 'DRAFT') {
        p.header.status = 'SUPERSEDED';
      }
    }
  }

  async insertPackage(row: NewPatternPackageRow): Promise<void> {
    this.packages.set(row.id, {
      header: { ...row, status: 'DRAFT', approvedBy: null, approvedAt: null },
      patterns: [],
      contrasts: [],
      evidenceRefs: [],
    });
  }

  async insertPatterns(rows: NewPatternRow[]): Promise<void> {
    for (const r of rows) this.packages.get(r.packageId)?.patterns.push(r);
  }

  async insertContrasts(rows: NewContrastRow[]): Promise<void> {
    for (const r of rows) this.packages.get(r.packageId)?.contrasts.push(r);
  }

  async insertEvidenceRefs(rows: NewPatternEvidenceRefRow[]): Promise<void> {
    for (const r of rows) this.packages.get(r.packageId)?.evidenceRefs.push(r);
  }

  getPackage(packageId: string): StoredPatternPackage | null {
    return this.packages.get(packageId) ?? null;
  }

  /**
   * Explicit synthetic operator approval (mirrors CompetitorPatternRepository.approvePackage): only a
   * DRAFT/REVIEWED package can move to APPROVED, and only under a named operator. Returns false when the
   * package is not in an approvable state. The harness runs the same validation gates as the real approve
   * command BEFORE calling this; this method performs the state transition only.
   */
  approvePackage(packageId: string, operator: string, at: Date): boolean {
    const p = this.packages.get(packageId);
    if (!p) return false;
    if (p.header.status !== 'DRAFT' && p.header.status !== 'REVIEWED') return false;
    if (operator.trim() === '') return false;
    p.header.status = 'APPROVED';
    p.header.approvedBy = operator.trim();
    p.header.approvedAt = at;
    return true;
  }
}
