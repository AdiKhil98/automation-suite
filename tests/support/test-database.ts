import { createDb, type Database, type DbHandle } from '../../src/persistence/db.js';
import { truncateAll } from '../../src/persistence/maintenance.js';
import { requireDestructiveTestDatabase, type DestructiveTestDatabasePermit } from '../../src/persistence/test-database-guard.js';

export interface IntegrationTestDatabase {
  createHandle(): DbHandle;
  truncate(db: Database): Promise<void>;
}

/**
 * Called during integration-test module initialization, before any pg pool is
 * constructed. There is deliberately no DATABASE_URL fallback.
 */
export function requireIntegrationTestDatabase(): IntegrationTestDatabase {
  const permit: DestructiveTestDatabasePermit = requireDestructiveTestDatabase();
  return {
    createHandle: () => createDb(permit.databaseUrl),
    truncate: (db) => truncateAll(db, permit),
  };
}
