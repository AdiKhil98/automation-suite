import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../../migrations/0020_controlled_test_orchestration.sql', import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../migrations/meta/_journal.json', import.meta.url), 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};
const schema = readFileSync(new URL('../../src/persistence/schema.ts', import.meta.url), 'utf8');

describe('migration 0020 metadata and safety', () => {
  it('is registered exactly once as the monotonic final entry', () => {
    const matching = journal.entries.filter((entry) => entry.tag === '0020_controlled_test_orchestration');
    expect(matching).toHaveLength(1);
    expect(matching[0]?.idx).toBe(20);
    expect(journal.entries.at(-1)?.tag).toBe('0020_controlled_test_orchestration');
    expect((matching[0]?.when ?? 0) > (journal.entries.at(-2)?.when ?? Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('is additive and defines the three non-sendable controlled tables', () => {
    const executableDestruction = /\b(DROP|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE\s+[^;]+\s+(DROP|RENAME|TYPE))\b/i;
    expect(migration).not.toMatch(executableDestruction);
    for (const table of ['controlled_test_runs', 'controlled_test_artifact_approvals', 'controlled_test_evaluations']) {
      expect(migration).toContain(`CREATE TABLE "${table}"`);
      expect(schema).toContain(`'${table}'`);
    }
    expect(migration).toContain('controlled_test_runs_not_sendable_ck');
    expect(migration).toContain('controlled_test_evaluations_not_sendable_ck');
    expect(migration).toContain("outcome = 'CONTROLLED_TEST_NOT_SENDABLE'");
    expect(migration).not.toContain('sending_readiness_approvals');
  });
});
