import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../../migrations/0031_competitor_pattern_packages.sql', import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../migrations/meta/_journal.json', import.meta.url), 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};
const schema = readFileSync(new URL('../../src/persistence/schema.ts', import.meta.url), 'utf8');

describe('migration 0031 metadata and safety', () => {
  it('is registered exactly once at its monotonic journal position (0031 is next unused)', () => {
    const matching = journal.entries.filter((e) => e.tag === '0031_competitor_pattern_packages');
    expect(matching).toHaveLength(1);
    expect(matching[0]?.idx).toBe(31);
    expect(journal.entries[31]?.tag).toBe('0031_competitor_pattern_packages');
    expect((matching[0]?.when ?? 0) > (journal.entries[30]?.when ?? Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('is additive only (no destructive statements)', () => {
    const executableDestruction = /\b(DROP|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE\s+[^;]+\s+(DROP|RENAME|TYPE))\b/i;
    expect(migration).not.toMatch(executableDestruction);
  });

  it('creates exactly the four Phase 7A3A tables, present in schema.ts', () => {
    for (const table of ['competitor_pattern_packages', 'competitor_patterns', 'competitor_prospect_contrasts', 'competitor_pattern_evidence_refs']) {
      expect(migration).toContain(`CREATE TABLE "${table}"`);
      expect(schema).toContain(`'${table}'`);
    }
  });

  it('defines deterministic idempotency + version uniqueness + immutable status constraints', () => {
    expect(migration).toContain('competitor_pattern_packages_idempotency_uk');
    expect(migration).toContain('competitor_pattern_packages_version_uk');
    expect(migration).toContain('competitor_pattern_packages_status_ck');
    expect(migration).toContain("status IN ('DRAFT','REVIEWED','APPROVED','REJECTED','SUPERSEDED','INVALIDATED')");
  });

  it('does not touch any email/gmail/sheets/sending schema (7A3A boundary)', () => {
    for (const forbidden of ['email_drafts', 'gmail_drafts', 'send_attempts', 'outreach_records', 'sending_readiness_approvals', 'competitor_evidence_used']) {
      expect(migration).not.toContain(forbidden);
    }
  });
});
