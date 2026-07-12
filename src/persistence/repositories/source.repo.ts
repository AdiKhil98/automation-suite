import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  type NewSourceEntity,
  type SourceEntity,
} from '../../domain/lead-sources/source-entity.js';
import { type NewSourceObservation } from '../../domain/lead-sources/source-observation.js';
import { type NewSourceRequest } from '../../domain/lead-sources/source-request.js';
import {
  type SourceRequestStore,
  type TxEntityStore,
  type TxObservationStore,
} from '../../pipeline/ports.js';
import { type DbExecutor } from '../db.js';
import { sourceEntities, sourceObservations, sourceRequests } from '../schema.js';

export class SourceRequestsRepository implements SourceRequestStore {
  constructor(private readonly db: DbExecutor) {}

  async record(req: NewSourceRequest): Promise<string> {
    const id = randomUUID();
    await this.db.insert(sourceRequests).values({
      id,
      runId: req.runId,
      campaign: req.campaign,
      provider: req.provider,
      query: req.query ?? null,
      fieldMask: req.fieldMask,
      pageIndex: req.pageIndex,
      resultCount: req.resultCount,
      billedTier: req.billedTier,
      estimatedCostUsd: req.estimatedCostUsd,
      status: req.status,
      startedAt: req.startedAt,
      completedAt: req.completedAt,
    });
    return id;
  }
}

export class SourceEntitiesRepository implements TxEntityStore {
  constructor(private readonly db: DbExecutor) {}

  async findByProviderPlaceId(
    provider: string,
    sourcePlaceId: string,
  ): Promise<SourceEntity | null> {
    const rows = await this.db
      .select()
      .from(sourceEntities)
      .where(
        and(eq(sourceEntities.provider, provider), eq(sourceEntities.sourcePlaceId, sourcePlaceId)),
      )
      .limit(1);
    const row = rows[0];
    return row ?? null;
  }

  async create(entity: NewSourceEntity): Promise<SourceEntity> {
    const now = new Date();
    const row = {
      id: randomUUID(),
      provider: entity.provider,
      sourcePlaceId: entity.sourcePlaceId,
      leadId: entity.leadId,
      firstSeenAt: now,
      lastSeenAt: now,
    };
    await this.db.insert(sourceEntities).values(row);
    return row;
  }

  async touchLastSeen(id: string, when: Date): Promise<void> {
    await this.db.update(sourceEntities).set({ lastSeenAt: when }).where(eq(sourceEntities.id, id));
  }
}

export class SourceObservationsRepository implements TxObservationStore {
  constructor(private readonly db: DbExecutor) {}

  async create(observation: NewSourceObservation): Promise<void> {
    await this.db.insert(sourceObservations).values({
      id: randomUUID(),
      sourceEntityId: observation.sourceEntityId,
      sourceRequestId: observation.sourceRequestId,
      processingResult: observation.processingResult,
      matchTier: observation.matchTier,
    });
  }
}
