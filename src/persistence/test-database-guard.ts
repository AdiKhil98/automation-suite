/**
 * Destructive database actions are test-only. Never derive this connection from
 * DATABASE_URL: that variable is reserved for the operational database.
 */
const permitMarker = Symbol('destructive-test-database-permit');

export interface DestructiveTestDatabasePermit {
  readonly databaseUrl: string;
  readonly [permitMarker]: true;
}

export type TestDatabaseEnvironment = Partial<Pick<NodeJS.ProcessEnv,
  'TEST_DATABASE_URL' | 'NODE_ENV' | 'ALLOW_TEST_DATABASE_DESTRUCTIVE_ACTIONS'>>;

const localHosts = new Set(['localhost', '127.0.0.1', '::1']);

function fail(code: string): never {
  throw new Error(`destructive_test_database_blocked:${code}`);
}

function testDatabaseName(pathname: string): string {
  const name = decodeURIComponent(pathname).replace(/^\/+/, '').toLowerCase();
  if (!name) fail('missing_database_name');
  return name;
}

function isClearlyTestOnly(name: string): boolean {
  return name === 'test' || name.startsWith('test_') || name.endsWith('_test') || name.includes('_test_');
}

/**
 * Validate the only URL allowed to back destructive integration work. This is
 * intentionally structural: it rejects a remote target before pg can open a
 * connection, even if a caller accidentally has a production DATABASE_URL.
 */
export function requireDestructiveTestDatabase(
  env: TestDatabaseEnvironment = process.env,
): DestructiveTestDatabasePermit {
  if (env.NODE_ENV !== 'test') fail('node_env_must_be_test');
  if (env.ALLOW_TEST_DATABASE_DESTRUCTIVE_ACTIONS !== 'true') fail('capability_not_enabled');
  const raw = env.TEST_DATABASE_URL;
  if (!raw) fail('test_database_url_required');

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail('invalid_test_database_url');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') fail('postgres_url_required');

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host.includes('supabase')) fail('supabase_disallowed');
  if (host.includes('pooler')) fail('pooler_disallowed');
  if (!localHosts.has(host)) fail('local_host_required');

  if (!isClearlyTestOnly(testDatabaseName(url.pathname))) fail('test_database_name_required');
  return { databaseUrl: raw, [permitMarker]: true };
}

/** Runtime check used by destructive helpers immediately before their SQL. */
export function assertDestructiveTestDatabasePermit(
  permit: DestructiveTestDatabasePermit | undefined,
): asserts permit is DestructiveTestDatabasePermit {
  if (!permit || permit[permitMarker] !== true) fail('permit_required');
}
