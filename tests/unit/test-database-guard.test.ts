import { describe, expect, it, vi } from 'vitest';
import { truncateAll } from '../../src/persistence/maintenance.js';
import { assertDestructiveTestDatabasePermit, requireDestructiveTestDatabase } from '../../src/persistence/test-database-guard.js';

const safe = {
  NODE_ENV: 'test',
  ALLOW_TEST_DATABASE_DESTRUCTIVE_ACTIONS: 'true',
  TEST_DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/outreach_test',
} as const;

describe('destructive test database guard', () => {
  it('accepts only an explicit local test database capability', () => {
    expect(requireDestructiveTestDatabase(safe).databaseUrl).toBe(safe.TEST_DATABASE_URL);
  });

  it.each([
    ['Supabase session pooler', 'postgresql://user:password@region.pooler.supabase.example:5432/outreach_test'],
    ['direct Supabase', 'postgresql://user:password@project.supabase.example:5432/outreach_test'],
    ['arbitrary remote PostgreSQL', 'postgresql://user:password@db.example.invalid:5432/outreach_test'],
    ['localhost without test database name', 'postgresql://postgres:postgres@localhost:5432/outreach'],
  ])('rejects %s', (_label, testUrl) => {
    expect(() => requireDestructiveTestDatabase({ ...safe, TEST_DATABASE_URL: testUrl })).toThrow('destructive_test_database_blocked');
  });

  it('rejects missing destructive capability', () => {
    expect(() => requireDestructiveTestDatabase({ ...safe, ALLOW_TEST_DATABASE_DESTRUCTIVE_ACTIONS: 'false' })).toThrow('capability_not_enabled');
  });

  it('rejects NODE_ENV other than test', () => {
    expect(() => requireDestructiveTestDatabase({ ...safe, NODE_ENV: 'development' })).toThrow('node_env_must_be_test');
  });

  it('rejects a DATABASE_URL-only fallback', () => {
    expect(() => requireDestructiveTestDatabase({ NODE_ENV: 'test', ALLOW_TEST_DATABASE_DESTRUCTIVE_ACTIONS: 'true' })).toThrow('test_database_url_required');
  });

  it('blocks truncateAll before it can execute SQL without a permit', async () => {
    const execute = vi.fn();
    await expect(truncateAll({ execute } as never, undefined)).rejects.toThrow('permit_required');
    expect(execute).not.toHaveBeenCalled();
    expect(() => assertDestructiveTestDatabasePermit(undefined)).toThrow('permit_required');
  });
});
