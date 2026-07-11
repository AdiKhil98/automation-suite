import { type Logger } from 'pino';
import { type AppConfig, loadConfig } from '../config/env.js';
import { LeadService } from '../domain/leads/lead-service.js';
import { createDb, type Database } from '../persistence/db.js';
import { LeadsRepository } from '../persistence/repositories/leads.repo.js';
import { PipelineRepository } from '../persistence/repositories/pipeline.repo.js';
import { createLogger } from '../utils/logger.js';

export interface CliContext {
  config: AppConfig;
  logger: Logger;
  db: Database;
  leads: LeadsRepository;
  events: PipelineRepository;
  service: LeadService;
}

/**
 * Build the runtime context (config, db, repositories, service), run the given
 * command, and always close the connection pool afterward. Logs the safety mode
 * (dry-run / outbound) on every invocation so it is never ambiguous.
 */
export async function withContext(fn: (ctx: CliContext) => Promise<void>): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  logger.info(
    {
      nodeEnv: config.NODE_ENV,
      dryRun: config.DRY_RUN,
      outboundEnabled: config.OUTBOUND_ACTIONS_ENABLED,
    },
    'automation-suite CLI',
  );

  const { db, pool } = createDb(config.DATABASE_URL);
  const leads = new LeadsRepository(db);
  const events = new PipelineRepository(db);
  const service = new LeadService(leads, events);

  try {
    await fn({ config, logger, db, leads, events, service });
  } finally {
    await pool.end();
  }
}
