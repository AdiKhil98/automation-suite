import {
  requireDestructiveTestDatabase,
  type DestructiveTestDatabasePermit,
} from './test-database-guard.js';

/**
 * Guard for Milestone 3B2A render persistence from the CLI.
 *
 * Persistence is OPT-IN and never derives its connection from `DATABASE_URL` (reserved for the
 * operational database). It requires an explicit capability flag plus a dedicated, structurally
 * validated loopback test database. Validation reuses the destructive-test-database guard, so a
 * remote / Supabase / pooler / production / non-test-named target is rejected before any pool opens.
 */
export type DemoV2PersistEnvironment = Partial<Pick<NodeJS.ProcessEnv,
  'ALLOW_DEMO_V2_PERSIST' | 'DEMO_V2_PERSIST_DATABASE_URL'>>;

export function requireDemoV2PersistDatabase(
  env: DemoV2PersistEnvironment = process.env,
): DestructiveTestDatabasePermit {
  if (env.ALLOW_DEMO_V2_PERSIST !== 'true') {
    throw new Error('demo_v2_persist_blocked:capability_not_enabled');
  }
  if (!env.DEMO_V2_PERSIST_DATABASE_URL) {
    throw new Error('demo_v2_persist_blocked:persist_database_url_required');
  }
  // Reuse the structural validation (loopback host, no supabase/pooler, test-only db name, no
  // DATABASE_URL fallback). The capability + dedicated URL above are the CLI-facing gate.
  return requireDestructiveTestDatabase({
    NODE_ENV: 'test',
    ALLOW_TEST_DATABASE_DESTRUCTIVE_ACTIONS: 'true',
    TEST_DATABASE_URL: env.DEMO_V2_PERSIST_DATABASE_URL,
  });
}
