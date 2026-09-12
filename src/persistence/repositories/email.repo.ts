import { type PersistedDraftRow } from '../../domain/email/resume-email-review.js';
import { type EmailPersist, type EmailRunStore } from '../../domain/email/email-writer-service.js';
import { eq } from 'drizzle-orm';
import { type DbExecutor } from '../db.js';
import { emailDrafts, emailFactInputs, emailFindingInputs, modelCalls } from '../schema.js';
import { isSequenceStep, type SequenceStep } from '../../domain/outreach/sequence.js';

/**
 * Narrow a stored `sequence_step` to the sequence type. The column is CHECK-constrained to 0..3, so
 * anything else means the row predates or violates that constraint; fail closed to 0 (INITIAL)
 * rather than asserting a follow-up position that was never written.
 */
function toSequenceStep(value: number): SequenceStep {
  return isSequenceStep(value) ? value : 0;
}

/** Persists one email run: the draft (with inline reviewer verdict), relational provenance
 * (fact + finding inputs), and the LLM model_calls (auditRunId = null; per-lead cost). */
export class EmailRepository implements EmailRunStore {
  constructor(private readonly db: DbExecutor) {}

  /** Read-only projection of one persisted draft (used by the reviewer-only resume path). */
  async getById(id: string): Promise<PersistedDraftRow | null> {
    const rows = await this.db.select().from(emailDrafts).where(eq(emailDrafts.id, id)).limit(1);
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id, leadId: r.leadId, runId: r.runId, status: r.status, subject: r.subject, body: r.body,
      demoId: r.demoId, writerPromptVersion: r.writerPromptVersion, schemaVersion: r.schemaVersion,
      rulesVersion: r.rulesVersion, provider: r.provider, requestedWriterModel: r.requestedWriterModel,
      writerResponseId: r.writerResponseId,
      // Sequence provenance (migration 0044). Pre-existing rows are step 0 by column default. A
      // threaded follow-up's stored subject already carries its "Re: " prefix, so replaying the
      // reviewer on it must treat the subject as thread continuity rather than authored copy.
      sequenceStep: toSequenceStep(r.sequenceStep), outreachRecordId: r.outreachRecordId,
      threadSubject: r.sequenceStep > 0 ? r.subject : null,
    };
  }

  async persist(record: EmailPersist): Promise<void> {
    if (record.email) {
      await this.db.insert(emailDrafts).values(record.email);
      if (record.factInputs.length > 0) await this.db.insert(emailFactInputs).values(record.factInputs);
      if (record.findingInputs.length > 0) await this.db.insert(emailFindingInputs).values(record.findingInputs);
    }
    if (record.modelCalls.length > 0) {
      await this.db.insert(modelCalls).values(
        record.modelCalls.map((m) => ({
          id: m.id, auditRunId: null, leadId: record.leadId, purpose: m.purpose, provider: m.provider,
          requestedModel: m.requestedModel, resolvedModel: m.resolvedModel, promptVersion: m.promptVersion, schemaVersion: m.schemaVersion,
          requestId: m.requestId, responseId: m.responseId, inputTokens: m.inputTokens, cachedInputTokens: m.cachedInputTokens,
          cacheWriteTokens: m.cacheWriteTokens, outputTokens: m.outputTokens, reasoningTokens: m.reasoningTokens,
          estimatedCostUsd: m.estimatedCostUsd, latencyMs: m.latencyMs, status: m.status, classification: m.status,
          retryNumber: m.retryNumber, imageDetail: null, validationViolations: m.validationViolations,
        })),
      );
    }
  }
}
