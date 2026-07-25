import { describe, expect, it } from 'vitest';
import { requireDemoV2PersistDatabase } from '../../src/persistence/demo-v2-persist-guard.js';

const LOCAL = 'postgresql://postgres:postgres@127.0.0.1:5432/outreach_test';

describe('Demo V2 persistence guard', () => {
  it('accepts an explicit loopback test database with the capability enabled', () => {
    const permit = requireDemoV2PersistDatabase({ ALLOW_DEMO_V2_PERSIST: 'true', DEMO_V2_PERSIST_DATABASE_URL: LOCAL });
    expect(permit.databaseUrl).toBe(LOCAL);
  });

  it('requires the explicit capability flag', () => {
    expect(() => requireDemoV2PersistDatabase({ DEMO_V2_PERSIST_DATABASE_URL: LOCAL }))
      .toThrow('capability_not_enabled');
  });

  it('never falls back to DATABASE_URL — a dedicated URL is required', () => {
    expect(() => requireDemoV2PersistDatabase({ ALLOW_DEMO_V2_PERSIST: 'true' }))
      .toThrow('persist_database_url_required');
  });

  it('rejects Supabase, pooler, remote, and non-test-named databases', () => {
    const cap = { ALLOW_DEMO_V2_PERSIST: 'true' as const };
    expect(() => requireDemoV2PersistDatabase({ ...cap, DEMO_V2_PERSIST_DATABASE_URL: 'postgresql://u:p@db.abc.supabase.co:5432/postgres' }))
      .toThrow('supabase_disallowed');
    expect(() => requireDemoV2PersistDatabase({ ...cap, DEMO_V2_PERSIST_DATABASE_URL: 'postgresql://u:p@aws-0.pooler.example:5432/x_test' }))
      .toThrow('pooler_disallowed');
    expect(() => requireDemoV2PersistDatabase({ ...cap, DEMO_V2_PERSIST_DATABASE_URL: 'postgresql://u:p@db.remote.example:5432/x_test' }))
      .toThrow('local_host_required');
    expect(() => requireDemoV2PersistDatabase({ ...cap, DEMO_V2_PERSIST_DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/production' }))
      .toThrow('test_database_name_required');
  });
});
