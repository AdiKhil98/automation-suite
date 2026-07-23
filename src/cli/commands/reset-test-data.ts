import { truncateAll } from '../../persistence/maintenance.js';
import { createDb } from '../../persistence/db.js';
import { requireDestructiveTestDatabase } from '../../persistence/test-database-guard.js';

/**
 * Clear only the validated local integration-test database. This command never
 * reads the operational connection setting, so it cannot open Supabase.
 */
export async function resetTestData(): Promise<void> {
  const permit = requireDestructiveTestDatabase();
  const { db, pool } = createDb(permit.databaseUrl);
  try {
    await truncateAll(db, permit);
  } finally {
    await pool.end();
  }
  console.log('All local integration-test pipeline data cleared.');
}
