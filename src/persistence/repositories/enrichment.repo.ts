import { randomUUID } from 'node:crypto';
import {
  type EnrichmentAttemptStore,
  type NewEnrichmentAttempt,
} from '../../domain/enrichment/enrichment-service.js';
import { type CandidateVerification } from '../../domain/enrichment/types.js';
import { type FactType } from '../../domain/lead-facts/lead-fact.js';
import { type DbExecutor } from '../db.js';
import { enrichmentAttempts, enrichmentCandidates, enrichmentSignals } from '../schema.js';

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
}
