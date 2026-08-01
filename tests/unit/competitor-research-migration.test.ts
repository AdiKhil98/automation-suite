import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../../migrations/0029_competitor_research.sql', import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../migrations/meta/_journal.json', import.meta.url), 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};
const schema = readFileSync(new URL('../../src/persistence/schema.ts', import.meta.url), 'utf8');

describe('migration 0029 metadata and safety', () => {
  it('is registered exactly once at its monotonic journal position', () => {
    const matching = journal.entries.filter((e) => e.tag === '0029_competitor_research');
    expect(matching).toHaveLength(1);
    expect(matching[0]?.idx).toBe(29);
    expect(journal.entries[29]?.tag).toBe('0029_competitor_research');
    expect((matching[0]?.when ?? 0) > (journal.entries[28]?.when ?? Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('is additive only (no destructive statements)', () => {
    const executableDestruction = /\b(DROP|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE\s+[^;]+\s+(DROP|RENAME|TYPE))\b/i;
    expect(migration).not.toMatch(executableDestruction);
  });

  it('creates exactly the two Phase 7A1 tables, present in schema.ts', () => {
    for (const table of ['competitor_research_runs', 'competitor_candidates']) {
      expect(migration).toContain(`CREATE TABLE "${table}"`);
      expect(schema).toContain(`'${table}'`);
    }
  });

  it('defines the deterministic idempotency + version uniqueness constraints', () => {
    expect(migration).toContain('competitor_research_runs_idempotency_uk');
    expect(migration).toContain('competitor_research_runs_version_uk');
    expect(migration).toContain('competitor_research_runs_outcome_ck');
    expect(migration).toContain('competitor_candidates_disposition_ck');
  });

  it('does not touch any email/gmail/sheets/sending schema (7A1 boundary)', () => {
    for (const forbidden of ['email_drafts', 'gmail_drafts', 'send_attempts', 'outreach_records', 'sending_readiness_approvals']) {
      expect(migration).not.toContain(forbidden);
    }
  });
});
