import { randomUUID } from 'node:crypto';
import { type DbExecutor } from '../db.js';
import { emailClaimLedger, emailCompetitorEnrichment, emailDrafts } from '../schema.js';
import { type ClaimLedgerEntry } from '../../domain/email/competitor-enrichment.js';

/**
 * Phase 7A3B persistence for an ENRICHED composed email: the email_drafts row plus the immutable
 * companion provenance + claim-ledger rows, in one transaction. Historical rows are never mutated; a
 * changed package or final body produces a NEW email_drafts id (a new composition/message version).
 * No Gmail/Sheets/sending path exists here.
 */
export interface EnrichedEmailRecord {
  emailId: string;
  leadId: string;
  demoId: string | null;
  runId: string | null;
  subject: string;
  body: string;
  ctaKind: string;
  hasDemoUrlPlaceholder: boolean;
  writerPromptVersion: string;
  reviewerPromptVersion: string;
  schemaVersion: string;
  rulesVersion: string;
  provider: string;
  requestedWriterModel: string;
  requestedReviewerModel: string;
  enrichment: {
    competitorEvidenceUsed: string;
    enrichmentRulesVersion: string;
    packageId: string;
    packageVersion: number;
    packageHash: string;
    selectedPatternId: string;
    selectedContrastId: string | null;
    primaryIssueEvidenceId: string;
    primaryIssueFindingRef: string;
    alignmentAuditCategory: string;
    alignmentEvidenceCategory: string;
    revalidatedAt: Date;
    recomputedHashMatched: boolean;
    composedMessageHash: string;
  };
  ledger: ClaimLedgerEntry[];
}

export class CompetitorEnrichmentRepository {
  constructor(private readonly db: DbExecutor) {}

  async persistEnrichedEmail(record: EnrichedEmailRecord): Promise<void> {
    await this.db.insert(emailDrafts).values({
      id: record.emailId,
      leadId: record.leadId,
      demoId: record.demoId,
      runId: record.runId,
      subject: record.subject,
      body: record.body,
      ctaKind: record.ctaKind,
      hasDemoUrlPlaceholder: record.hasDemoUrlPlaceholder,
      status: 'DRAFTED',
      writerPromptVersion: record.writerPromptVersion,
      reviewerPromptVersion: record.reviewerPromptVersion,
      schemaVersion: record.schemaVersion,
      rulesVersion: record.rulesVersion,
      provider: record.provider,
      requestedWriterModel: record.requestedWriterModel,
      requestedReviewerModel: record.requestedReviewerModel,
      totalCostUsd: 0,
    });

    const enrichmentId = randomUUID();
    await this.db.insert(emailCompetitorEnrichment).values({
      id: enrichmentId,
      emailId: record.emailId,
      leadId: record.leadId,
      competitorEvidenceUsed: record.enrichment.competitorEvidenceUsed,
      schemaVersion: record.schemaVersion,
      rulesVersion: record.enrichment.enrichmentRulesVersion,
      packageId: record.enrichment.packageId,
      packageVersion: record.enrichment.packageVersion,
      packageHash: record.enrichment.packageHash,
      selectedPatternId: record.enrichment.selectedPatternId,
      selectedContrastId: record.enrichment.selectedContrastId,
      primaryIssueEvidenceId: record.enrichment.primaryIssueEvidenceId,
      primaryIssueFindingRef: record.enrichment.primaryIssueFindingRef,
      alignmentAuditCategory: record.enrichment.alignmentAuditCategory,
      alignmentEvidenceCategory: record.enrichment.alignmentEvidenceCategory,
      revalidatedAt: record.enrichment.revalidatedAt,
      recomputedHashMatched: record.enrichment.recomputedHashMatched,
      composedMessageHash: record.enrichment.composedMessageHash,
    });

    if (record.ledger.length > 0) {
      await this.db.insert(emailClaimLedger).values(
        record.ledger.map((entry, index) => ({
          id: randomUUID(),
          emailId: record.emailId,
          enrichmentId,
          ordinal: index,
          claimType: entry.claimType,
          text: entry.text,
          prospectEvidenceIds: entry.prospectEvidenceIds,
          patternId: entry.patternId,
          contrastId: entry.contrastId,
          competitorEvidenceIds: entry.competitorEvidenceIds,
          packageId: record.enrichment.packageId,
          packageVersion: record.enrichment.packageVersion,
          packageHash: record.enrichment.packageHash,
          rulesVersion: record.enrichment.enrichmentRulesVersion,
          validatedAt: record.enrichment.revalidatedAt,
          externallySafe: entry.externallySafe,
        })),
      );
    }
  }
}
