import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { type EventRecorder } from '../../domain/leads/lead-service.js';
import { type NewPipelineEvent, type PipelineEvent } from '../../domain/pipeline/pipeline-event.js';
import { type LeadStatus } from '../../domain/leads/status.js';
import { type Database } from '../db.js';
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

export class PipelineRepository implements EventRecorder {
  constructor(private readonly db: Database) {}

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
}
