import { and, desc, eq, ne, inArray } from 'drizzle-orm';
import {
  type CompetitorPatternStore,
  type NewContrastRow,
  type NewPatternEvidenceRefRow,
  type NewPatternPackageRow,
  type NewPatternRow,
} from '../../domain/competitor/pattern-service.js';
import { type DbExecutor } from '../db.js';
import {
  competitorPatternEvidenceRefs,
  competitorPatternPackages,
  competitorPatterns,
  competitorProspectContrasts,
} from '../schema.js';

/**
 * Phase 7A3A persistence for competitor pattern packages + patterns + contrasts + evidence refs.
 * Immutable/versioned: packages are inserted, prior DRAFT packages for a lead are marked SUPERSEDED
 * (never deleted), and identical (lead_id,input_hash,config_hash) reuses the existing package via the
 * idempotency unique index. Approval/rejection/invalidation are explicit, guarded status transitions
 * that preserve immutable history. No email/Gmail/Sheets/sending path exists here.
 */
export class CompetitorPatternRepository implements CompetitorPatternStore {
  constructor(private readonly db: DbExecutor) {}

  async findPackageByHashes(leadId: string, inputHash: string, configHash: string): Promise<{ id: string; version: number; status: string } | null> {
    const rows = await this.db
      .select({ id: competitorPatternPackages.id, version: competitorPatternPackages.version, status: competitorPatternPackages.status })
      .from(competitorPatternPackages)
      .where(and(eq(competitorPatternPackages.leadId, leadId), eq(competitorPatternPackages.inputHash, inputHash), eq(competitorPatternPackages.configHash, configHash)))
      .limit(1);
    return rows[0] ?? null;
  }

  async maxVersionForLead(leadId: string): Promise<number> {
    const rows = await this.db
      .select({ version: competitorPatternPackages.version })
      .from(competitorPatternPackages)
      .where(eq(competitorPatternPackages.leadId, leadId))
      .orderBy(desc(competitorPatternPackages.version))
      .limit(1);
    return rows[0]?.version ?? 0;
  }

  async supersedePriorDraftPackages(leadId: string, newPackageId: string): Promise<void> {
    await this.db
      .update(competitorPatternPackages)
      .set({ status: 'SUPERSEDED', supersededBy: newPackageId })
      .where(and(eq(competitorPatternPackages.leadId, leadId), eq(competitorPatternPackages.status, 'DRAFT'), ne(competitorPatternPackages.id, newPackageId)));
  }

  async insertPackage(row: NewPatternPackageRow): Promise<void> {
    await this.db.insert(competitorPatternPackages).values({
      id: row.id,
      leadId: row.leadId,
      researchRunId: row.researchRunId,
      status: row.status,
      version: row.version,
      inputHash: row.inputHash,
      configHash: row.configHash,
      packageHash: row.packageHash,
      rulesVersion: row.rulesVersion,
      confidence: row.confidence,
      freshnessEvaluatedAt: row.freshnessEvaluatedAt,
      selectedCompetitorIds: row.selectedCompetitorIds,
      captureRunIds: row.captureRunIds,
      eligibleEvidenceCount: row.eligibleEvidenceCount,
      excludedEvidenceCount: row.excludedEvidenceCount,
      exclusionReasons: row.exclusions,
      prohibitedClaims: row.prohibitedClaims,
    });
  }

  async insertPatterns(rows: NewPatternRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.insert(competitorPatterns).values(
      rows.map((r) => ({
        id: r.id,
        packageId: r.packageId,
        category: r.pattern.category,
        result: r.pattern.result,
        presentCount: r.pattern.presentCount,
        absentCount: r.pattern.absentCount,
        unknownCount: r.pattern.unknownCount,
        usableDenominator: r.pattern.usableDenominator,
        totalSelected: r.pattern.totalSelected,
        participatingCompetitorIds: r.pattern.participatingCompetitorIds,
        evidenceItemIds: r.pattern.evidenceItemIds,
        confidence: r.pattern.confidence,
        wordingForm: r.pattern.wordingForm,
        wordingText: r.pattern.wordingText,
        consequenceLabel: r.pattern.consequenceLabel,
        numericMedian: r.pattern.numericMedian,
        numericValues: r.pattern.numericValues,
        isDepth: r.pattern.isDepth,
      })),
    );
  }

  async insertContrasts(rows: NewContrastRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.insert(competitorProspectContrasts).values(
      rows.map((r) => ({
        id: r.id,
        packageId: r.packageId,
        patternId: r.patternId,
        category: r.contrast.category,
        contrastKind: r.contrast.contrastKind,
        prospectState: r.contrast.prospectState,
        prospectEvidenceRef: r.contrast.prospectEvidenceRef,
        confidence: r.contrast.confidence,
        consequenceLabel: r.contrast.consequenceLabel,
      })),
    );
  }

  async insertEvidenceRefs(rows: NewPatternEvidenceRefRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.insert(competitorPatternEvidenceRefs).values(
      rows.map((r) => ({
        id: r.id,
        packageId: r.packageId,
        kind: r.ref.kind,
        evidenceItemId: r.ref.evidenceItemId,
        captureRunId: r.ref.captureRunId,
        competitorCandidateId: r.ref.competitorCandidateId,
        category: r.ref.category,
        sourceUrl: r.ref.sourceUrl,
      })),
    );
  }

  // --- read side (review CLI; not part of the write store port) ---

  async listPackagesForLead(leadId: string): Promise<(typeof competitorPatternPackages.$inferSelect)[]> {
    return this.db
      .select()
      .from(competitorPatternPackages)
      .where(eq(competitorPatternPackages.leadId, leadId))
      .orderBy(desc(competitorPatternPackages.version));
  }

  async getPackage(packageId: string): Promise<typeof competitorPatternPackages.$inferSelect | null> {
    const rows = await this.db.select().from(competitorPatternPackages).where(eq(competitorPatternPackages.id, packageId)).limit(1);
    return rows[0] ?? null;
  }

  async getPatterns(packageId: string): Promise<(typeof competitorPatterns.$inferSelect)[]> {
    return this.db.select().from(competitorPatterns).where(eq(competitorPatterns.packageId, packageId)).orderBy(competitorPatterns.category);
  }

  async getContrasts(packageId: string): Promise<(typeof competitorProspectContrasts.$inferSelect)[]> {
    return this.db.select().from(competitorProspectContrasts).where(eq(competitorProspectContrasts.packageId, packageId));
  }

  async getEvidenceRefs(packageId: string): Promise<(typeof competitorPatternEvidenceRefs.$inferSelect)[]> {
    return this.db.select().from(competitorPatternEvidenceRefs).where(eq(competitorPatternEvidenceRefs.packageId, packageId));
  }

  /**
   * Approve a DRAFT/REVIEWED package (explicit operator identity required). Returns true when a row
   * transitioned. History is preserved — this only stamps status + approver metadata.
   */
  async approvePackage(packageId: string, operator: string, at: Date): Promise<boolean> {
    const rows = await this.db
      .update(competitorPatternPackages)
      .set({ status: 'APPROVED', approvedBy: operator, approvedAt: at })
      .where(and(eq(competitorPatternPackages.id, packageId), inArray(competitorPatternPackages.status, ['DRAFT', 'REVIEWED'])))
      .returning({ id: competitorPatternPackages.id });
    return rows.length > 0;
  }

  /** Reject a DRAFT/REVIEWED package (explicit operator action). History preserved. */
  async rejectPackage(packageId: string, operator: string, at: Date): Promise<boolean> {
    const rows = await this.db
      .update(competitorPatternPackages)
      .set({ status: 'REJECTED', rejectedBy: operator, rejectedAt: at })
      .where(and(eq(competitorPatternPackages.id, packageId), inArray(competitorPatternPackages.status, ['DRAFT', 'REVIEWED'])))
      .returning({ id: competitorPatternPackages.id });
    return rows.length > 0;
  }

  /**
   * Invalidate a package (e.g. underlying evidence changed). Any non-terminal state → INVALIDATED.
   * Evidence references and patterns remain for historical traceability (never deleted).
   */
  async invalidatePackage(packageId: string, operator: string, at: Date): Promise<boolean> {
    const rows = await this.db
      .update(competitorPatternPackages)
      .set({ status: 'INVALIDATED', invalidatedBy: operator, invalidatedAt: at })
      .where(and(eq(competitorPatternPackages.id, packageId), inArray(competitorPatternPackages.status, ['DRAFT', 'REVIEWED', 'APPROVED'])))
      .returning({ id: competitorPatternPackages.id });
    return rows.length > 0;
  }
}
