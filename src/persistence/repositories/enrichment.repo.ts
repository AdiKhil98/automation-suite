import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import {
  type EnrichmentAttemptStore,
  type NewEnrichmentAttempt,
} from '../../domain/enrichment/enrichment-service.js';
import { type CandidateVerification } from '../../domain/enrichment/types.js';
import { type WebsiteVerificationAttempt } from '../../integrations/enrichment/provider.js';
import { type FactType } from '../../domain/lead-facts/lead-fact.js';
import { type DbExecutor } from '../db.js';
import {
  enrichmentAttempts,
  enrichmentCandidates,
  enrichmentSignals,
  websiteVerificationAttempts,
} from '../schema.js';

export class EnrichmentRepository implements EnrichmentAttemptStore {
  constructor(private readonly db: DbExecutor) {}

  async recordAttempt(attempt: NewEnrichmentAttempt): Promise<string> {
    const id = randomUUID();
    await this.db.insert(enrichmentAttempts).values({ id, ...attempt });
    return id;
  }

  /** Insert candidate rows + their structured signals; link signals to facts via linkFor. */
  async recordCandidates(
    attemptId: string,
    verifications: CandidateVerification[],
    linkFor: (matchedFactType: FactType | null) => string | null,
  ): Promise<void> {
    for (const v of verifications) {
      const candidateId = randomUUID();
      await this.db.insert(enrichmentCandidates).values({
        id: candidateId,
        attemptId,
        discoveredUrl: v.requestedUrl,
        finalUrl: v.finalUrl,
        host: v.host,
        httpStatus: v.httpStatus,
        discoverySource: v.discoverySource,
        isDirectory: v.isDirectory,
        decision: v.decision,
        confidence: v.confidence,
        rejectedReason: v.rejectedReason,
      });
      for (const s of v.signals) {
        await this.db.insert(enrichmentSignals).values({
          id: randomUUID(),
          candidateId,
          matchedFactId: v.decision === 'VERIFIED' ? linkFor(s.matchedFactType) : null,
          signalType: s.signalType,
          pageUrl: s.pageUrl,
          extractedValue: s.extractedValue,
          normalizedValue: s.normalizedValue,
          selector: s.selector,
          confidence: s.confidence,
        });
      }
    }
  }

  async recordVerificationAttempts(
    leadId: string,
    enrichmentAttemptId: string,
    attempts: WebsiteVerificationAttempt[],
  ): Promise<void> {
    if (attempts.length === 0) return;
    await this.db.insert(websiteVerificationAttempts).values(
      attempts.map((attempt) => ({
        id: randomUUID(),
        leadId,
        enrichmentAttemptId,
        ...attempt,
      })),
    );
  }

  async latestVerificationForLead(leadId: string): Promise<typeof websiteVerificationAttempts.$inferSelect | null> {
    const rows = await this.db
      .select()
      .from(websiteVerificationAttempts)
      .where(eq(websiteVerificationAttempts.leadId, leadId))
      .orderBy(desc(websiteVerificationAttempts.attemptedAt))
      .limit(1);
    return rows[0] ?? null;
  }
}
