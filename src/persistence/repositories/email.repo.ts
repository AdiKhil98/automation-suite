import { type EmailPersist, type EmailRunStore } from '../../domain/email/email-writer-service.js';
import { type DbExecutor } from '../db.js';
import { emailDrafts, emailFactInputs, emailFindingInputs, modelCalls } from '../schema.js';

/** Persists one email run: the draft (with inline reviewer verdict), relational provenance
 * (fact + finding inputs), and the LLM model_calls (auditRunId = null; per-lead cost). */
export class EmailRepository implements EmailRunStore {
  constructor(private readonly db: DbExecutor) {}

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
