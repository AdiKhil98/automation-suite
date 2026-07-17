import { type ComposerPersist, type ComposerRunStore } from '../../domain/demo/composer/demo-composer-service.js';
import { type DbExecutor } from '../db.js';
import { demoDecisions, demoDesignSpecs, demoFactInputs, demoFindingInputs, demos, modelCalls } from '../schema.js';

/**
 * Persists one composer run: the demo decision, the demo record (when composed), its
 * RELATIONAL provenance (fact + finding inputs), the structured design spec, and the LLM
 * model_calls (auditRunId = null; these are demo-composer calls, tracked per lead for cost).
 * Authoritative provenance is FK-based, not JSON.
 */
export class ComposerRepository implements ComposerRunStore {
  constructor(private readonly db: DbExecutor) {}

  async persist(record: ComposerPersist): Promise<void> {
    await this.db.insert(demoDecisions).values({
      id: record.decision.id,
      leadId: record.decision.leadId,
      runId: record.decision.runId,
      decision: record.decision.decision,
      outcome: record.decision.outcome,
      reason: record.decision.reason,
      opportunityScore: record.decision.opportunityScore,
      minOpportunity: record.decision.minOpportunity,
      justifiedByScore: record.decision.justifiedByScore,
      justifiedByFinding: record.decision.justifiedByFinding,
      briefRulesVersion: record.decision.briefRulesVersion,
    });

    if (record.demo) {
      await this.db.insert(demos).values(record.demo);
      if (record.designSpec) await this.db.insert(demoDesignSpecs).values(record.designSpec);
      if (record.factInputs.length > 0) await this.db.insert(demoFactInputs).values(record.factInputs);
      if (record.findingInputs.length > 0) await this.db.insert(demoFindingInputs).values(record.findingInputs);
    }

    if (record.modelCalls.length > 0) {
      await this.db.insert(modelCalls).values(
        record.modelCalls.map((m) => ({
          id: m.id,
          auditRunId: null,
          leadId: record.decision.leadId,
          purpose: m.purpose,
          provider: m.provider,
          requestedModel: m.requestedModel,
          resolvedModel: m.resolvedModel,
          promptVersion: m.promptVersion,
          schemaVersion: m.schemaVersion,
          requestId: m.requestId,
          responseId: m.responseId,
          inputTokens: m.inputTokens,
          cachedInputTokens: m.cachedInputTokens,
          cacheWriteTokens: m.cacheWriteTokens,
          outputTokens: m.outputTokens,
          reasoningTokens: m.reasoningTokens,
          estimatedCostUsd: m.estimatedCostUsd,
          latencyMs: m.latencyMs,
          status: m.status,
          classification: m.status,
          retryNumber: m.retryNumber,
          imageDetail: null,
          validationViolations: m.validationViolations,
        })),
      );
    }
  }
}
