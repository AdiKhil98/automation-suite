import { type Logger } from 'pino';
import { routeAuditOutcome } from './audit-outcome.js';
import { type AuditEnvelope, type AuditUnitOfWork } from './audit-service.js';

export interface EnvelopeSource {
  list(): Promise<AuditEnvelope[]>;
  delete(key: string): Promise<void>;
}

export interface RecoverySummary {
  scanned: number;
  replayed: number;
  alreadyPersisted: number;
  failed: number;
}

/**
 * Startup/CLI recovery: replay paid-result envelopes whose DB persistence failed.
 * Idempotent — an envelope whose audit run already exists is just cleaned up. NEVER
 * makes model calls; it only re-runs the persistence transaction from stored results.
 */
export async function recoverEnvelopes(
  uow: AuditUnitOfWork,
  store: EnvelopeSource,
  logger: Logger,
): Promise<RecoverySummary> {
  const summary: RecoverySummary = { scanned: 0, replayed: 0, alreadyPersisted: 0, failed: 0 };
  for (const env of await store.list()) {
    summary.scanned += 1;
    const { persist } = env;
    const key = env.idempotencyKey;
    try {
      const already = await uow.transaction((repos) => repos.audit.exists(persist.auditRun.id));
      if (already) {
        summary.alreadyPersisted += 1;
        await store.delete(key);
        continue;
      }
      await uow.transaction(async (repos) => {
        if (await repos.audit.exists(persist.auditRun.id)) return; // raced: already replayed
        const lead = await repos.leads.getById(persist.auditRun.leadId);
        if (lead && lead.status === 'READY_FOR_AUDIT') {
          const route = routeAuditOutcome(persist.auditRun.outcome);
          if (route === 'AUDITED_THEN_OPPORTUNITY') {
            await repos.leadService.transition(lead.id, 'AUDITED');
            await repos.leadService.transition(lead.id, 'OPPORTUNITY_READY');
          } else if (route === 'NEEDS_MANUAL_REVIEW') {
            await repos.leadService.transition(lead.id, 'NEEDS_MANUAL_REVIEW');
          }
        }
        await repos.audit.persist(persist);
        await repos.events.record({
          leadId: persist.auditRun.leadId,
          runId: persist.auditRun.runId,
          type: 'NOTE',
          fromStatus: null,
          toStatus: null,
          message: `audit envelope replayed: ${persist.auditRun.outcome}`,
          data: { auditRunId: persist.auditRun.id, replay: true },
        });
      });
      summary.replayed += 1;
      await store.delete(key);
    } catch (err) {
      summary.failed += 1;
      logger.error({ key, err: err instanceof Error ? err.message : String(err) }, 'envelope replay failed (kept for retry)');
    }
  }
  return summary;
}
