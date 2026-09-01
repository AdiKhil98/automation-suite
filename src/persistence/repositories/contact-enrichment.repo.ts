import { and, eq } from 'drizzle-orm';
import {
  type CandidatePerson,
  type ContactEnrichmentOutcome,
  type ContactEnrichmentResult,
  type EnrichmentMode,
  type VerifiedContact,
} from '../../domain/contact-enrichment/types.js';
import { type ContactEnrichmentStore } from '../../domain/contact-enrichment/service.js';
import { type DbExecutor } from '../db.js';
import { contactEnrichmentResults } from '../schema.js';

type Row = typeof contactEnrichmentResults.$inferSelect;

function toDomain(row: Row): ContactEnrichmentResult {
  const accepted: VerifiedContact | null =
    row.outcome === 'VERIFIED' && row.acceptedEmail
      ? {
          fullName: row.acceptedName ?? '',
          title: row.acceptedTitle ?? '',
          email: row.acceptedEmail,
          verificationStatus: 'VERIFIED',
          dataQuality: row.dataQuality,
          confidence: row.confidence,
        }
      : null;
  return {
    id: row.id,
    leadId: row.leadId,
    provider: row.provider,
    mode: row.mode as EnrichmentMode,
    inputHash: row.inputHash,
    requestedDomain: row.requestedDomain,
    candidates: row.candidates as CandidatePerson[],
    outcome: row.outcome as ContactEnrichmentOutcome,
    accepted,
    creditsEstimated: row.creditsUsed,
    creditsReported: row.creditsReported,
    providerResourceId: row.providerResourceId,
    endpoint: row.endpoint,
    provenance: (row.provenance ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

/**
 * Persistence for contact enrichment runs. The idempotency unique index on
 * (lead_id, provider, mode, input_hash) backs {@link findByInputHash}; the service consults it before
 * any spend. Mode (PREVIEW vs ENRICH) is part of the identity so a non-paid preview and a paid
 * enrichment for the same lead/domain/candidates never suppress each other. This repo never touches
 * lead_facts, so no manual contact fact can be overwritten.
 */
export class ContactEnrichmentRepository implements ContactEnrichmentStore {
  constructor(private readonly db: DbExecutor) {}

  async findByInputHash(leadId: string, provider: string, mode: EnrichmentMode, inputHash: string): Promise<ContactEnrichmentResult | null> {
    const rows = await this.db
      .select()
      .from(contactEnrichmentResults)
      .where(
        and(
          eq(contactEnrichmentResults.leadId, leadId),
          eq(contactEnrichmentResults.provider, provider),
          eq(contactEnrichmentResults.mode, mode),
          eq(contactEnrichmentResults.inputHash, inputHash),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? toDomain(row) : null;
  }

  async save(result: ContactEnrichmentResult): Promise<void> {
    await this.db.insert(contactEnrichmentResults).values({
      id: result.id,
      leadId: result.leadId,
      provider: result.provider,
      mode: result.mode,
      inputHash: result.inputHash,
      requestedDomain: result.requestedDomain,
      candidates: result.candidates,
      outcome: result.outcome,
      acceptedName: result.accepted?.fullName ?? null,
      acceptedTitle: result.accepted?.title ?? null,
      acceptedEmail: result.accepted?.email ?? null,
      verificationStatus: result.accepted?.verificationStatus ?? null,
      dataQuality: result.accepted?.dataQuality ?? null,
      confidence: result.accepted?.confidence ?? null,
      creditsUsed: result.creditsEstimated,
      creditsReported: result.creditsReported,
      providerResourceId: result.providerResourceId,
      endpoint: result.endpoint,
      provenance: result.provenance,
      createdAt: result.createdAt,
      completedAt: result.completedAt,
    });
  }
}
