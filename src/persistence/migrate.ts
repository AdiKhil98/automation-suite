import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadConfig } from '../config/env.js';
import { createLogger } from '../utils/logger.js';
import { createDb } from './db.js';

/**
 * Apply all pending migrations from ./migrations. Reads DATABASE_URL from the
 * validated config. Safe to re-run: Drizzle tracks applied migrations.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const { db, pool } = createDb(config.DATABASE_URL);
  try {
    logger.info('Applying migrations from ./migrations');
    await migrate(db, { migrationsFolder: 'migrations' });
    logger.info('Migrations applied successfully');
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);

  console.error(`Migration failed: ${message}`);
  process.exitCode = 1;
});
