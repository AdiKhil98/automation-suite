import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { type PipelineRunStatus } from '../../domain/pipeline/pipeline-run.js';
import { type DbExecutor } from '../db.js';
import { pipelineRuns } from '../schema.js';

export class PipelineRunsRepository {
  constructor(private readonly db: DbExecutor) {}

  async start(kind: string, dryRun: boolean): Promise<string> {
    const id = randomUUID();
    await this.db.insert(pipelineRuns).values({
      id,
      kind,
      status: 'RUNNING',
      dryRun: dryRun ? 'true' : 'false',
      startedAt: new Date(),
    });
    return id;
  }

  async finish(id: string, status: PipelineRunStatus, notes?: string): Promise<void> {
    await this.db
      .update(pipelineRuns)
      .set({ status, finishedAt: new Date(), notes: notes ?? null })
      .where(eq(pipelineRuns.id, id));
  }
}
