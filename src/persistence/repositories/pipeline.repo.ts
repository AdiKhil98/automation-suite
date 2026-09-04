import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { type EventRecorder } from '../../domain/leads/lead-service.js';
import { type NewPipelineEvent, type PipelineEvent } from '../../domain/pipeline/pipeline-event.js';
import { type LeadStatus } from '../../domain/leads/status.js';
import { type TxEventRecorder } from '../../pipeline/ports.js';
import { type DbExecutor } from '../db.js';
import { pipelineEvents } from '../schema.js';

type EventRow = typeof pipelineEvents.$inferSelect;

function toDomain(row: EventRow): PipelineEvent {
  return {
    id: row.id,
    leadId: row.leadId,
    runId: row.runId,
    type: row.type as PipelineEvent['type'],
    fromStatus: (row.fromStatus as LeadStatus | null) ?? null,
    toStatus: (row.toStatus as LeadStatus | null) ?? null,
    message: row.message,
    data: row.data ?? null,
    createdAt: row.createdAt,
  };
}

export class PipelineRepository implements EventRecorder, TxEventRecorder {
  constructor(private readonly db: DbExecutor) {}

  async record(event: NewPipelineEvent): Promise<void> {
    await this.db.insert(pipelineEvents).values({
      id: randomUUID(),
      leadId: event.leadId,
      runId: event.runId,
      type: event.type,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      message: event.message,
      data: event.data ?? null,
    });
  }

  async listByLead(leadId: string): Promise<PipelineEvent[]> {
    const rows = await this.db
      .select()
      .from(pipelineEvents)
      .where(eq(pipelineEvents.leadId, leadId))
      .orderBy(asc(pipelineEvents.createdAt));
    return rows.map(toDomain);
  }

  /**
   * Durable qualification signal: which of `leadIds` have EVER recorded a `STATE_TRANSITION` whose
   * `toStatus` is `status`, at any point in their history — regardless of their current status.
   * `pipeline_events` is append-only, so this survives a lead moving on to later stages (capture,
   * audit, ...) and stays accurate even after `status` itself became a transient pass-through state.
   * Used to decide "did this lead ever pass qualification" without relying on the current `leads.status`
   * column, which a later stage may have already advanced past.
   */
  async leadsEverReachedStatus(leadIds: readonly string[], status: LeadStatus): Promise<Set<string>> {
    if (leadIds.length === 0) return new Set();
    const rows = await this.db
      .selectDistinct({ leadId: pipelineEvents.leadId })
      .from(pipelineEvents)
      .where(
        and(
          inArray(pipelineEvents.leadId, leadIds as string[]),
          eq(pipelineEvents.type, 'STATE_TRANSITION'),
          eq(pipelineEvents.toStatus, status),
        ),
      );
    return new Set(rows.map((r) => r.leadId).filter((id): id is string => id !== null));
  }
}
