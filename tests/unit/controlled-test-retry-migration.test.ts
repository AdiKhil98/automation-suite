import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../../migrations/0021_controlled_test_retry_index.sql', import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../migrations/meta/_journal.json', import.meta.url), 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};
const schema = readFileSync(new URL('../../src/persistence/schema.ts', import.meta.url), 'utf8');

describe('migration 0021 controlled-test retry index', () => {
  it('is registered exactly once at its monotonic journal position', () => {
    const matching = journal.entries.filter((entry) => entry.tag === '0021_controlled_test_retry_index');
    expect(matching).toHaveLength(1);
    expect(matching[0]?.idx).toBe(21);
    expect(journal.entries[21]?.tag).toBe('0021_controlled_test_retry_index');
    expect((matching[0]?.when ?? 0) > (journal.entries[20]?.when ?? Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('allows retry after failure while blocking concurrent or post-success duplicates', () => {
    expect(migration).toContain('DROP INDEX "controlled_test_runs_prospect_run_uk"');
    expect(migration).toContain('CREATE UNIQUE INDEX "controlled_test_runs_prospect_run_uk"');
    expect(migration).toContain("WHERE \"status\" IN ('RUNNING','COMPLETED')");
    expect(migration).not.toMatch(/\b(TRUNCATE|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE)\b/i);
    expect(schema).toContain(".where(sql`${t.status} IN ('RUNNING','COMPLETED')`)");
  });
});
