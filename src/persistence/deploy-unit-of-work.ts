import { type DeployTxRepos, type DeployUnitOfWork, type DeploymentRunRecord, type FinalizationRecord } from '../domain/deploy/deployment-service.js';
import { LeadService } from '../domain/leads/lead-service.js';
import { type Database } from './db.js';
import { DeployTxRepository } from './repositories/deploy.repo.js';
import { LeadsRepository } from './repositories/leads.repo.js';
import { PipelineRepository } from './repositories/pipeline.repo.js';

/** One atomic transaction for the terminal deployment write: run completion + finalization +
 * lead state + event. */
export class DrizzleDeployUnitOfWork implements DeployUnitOfWork {
  constructor(private readonly db: Database) {}

  async transaction<T>(fn: (repos: DeployTxRepos) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const leads = new LeadsRepository(tx);
      const events = new PipelineRepository(tx);
      const deploy = new DeployTxRepository(tx);
      return fn({
        leads,
        leadService: new LeadService(leads, events),
        completeRun: (runId: string, patch: Partial<DeploymentRunRecord>) => deploy.completeRun(runId, patch),
        createFinalization: (row: FinalizationRecord) => deploy.createFinalization(row),
        events,
      });
    });
  }
}
