import { type DemoPersist, type DemoRunStore } from '../../domain/demo/demo-service.js';
import { type DbExecutor } from '../db.js';
import { demoDecisions, demoFactInputs, demoFindingInputs, demos } from '../schema.js';

/** Persists a demo decision, the demo record, and its RELATIONAL provenance links
 * (fact inputs + finding inputs). Authoritative provenance is FK-based, not JSON. */
export class DemoRepository implements DemoRunStore {
  constructor(private readonly db: DbExecutor) {}

  async persist(record: DemoPersist): Promise<void> {
    await this.db.insert(demoDecisions).values(record.decision);

    if (record.demo) {
      await this.db.insert(demos).values(record.demo);
      if (record.factInputs.length > 0) await this.db.insert(demoFactInputs).values(record.factInputs);
      if (record.findingInputs.length > 0) await this.db.insert(demoFindingInputs).values(record.findingInputs);
    }
  }
}
