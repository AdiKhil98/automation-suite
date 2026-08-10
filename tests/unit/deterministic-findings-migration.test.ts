import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../../migrations/0034_deterministic_findings.sql', import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../migrations/meta/_journal.json', import.meta.url), 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};
const schema = readFileSync(new URL('../../src/persistence/schema.ts', import.meta.url), 'utf8');

describe('migration 0034 metadata and safety', () => {
  it('is registered exactly once at its monotonic journal position (0034 is next unused)', () => {
    const matching = journal.entries.filter((e) => e.tag === '0034_deterministic_findings');
    expect(matching).toHaveLength(1);
    expect(matching[0]?.idx).toBe(34);
    expect(journal.entries[34]?.tag).toBe('0034_deterministic_findings');
    expect((matching[0]?.when ?? 0) > (journal.entries[33]?.when ?? Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('is additive only (no destructive statements)', () => {
    const executableDestruction = /\b(DROP|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE\s+[^;]+\s+(DROP|RENAME|TYPE))\b/i;
    expect(migration).not.toMatch(executableDestruction);
  });

  it('creates exactly the two bridge tables, present in schema.ts', () => {
    for (const table of ['deterministic_findings', 'deterministic_finding_evidence']) {
      expect(migration).toContain(`CREATE TABLE "${table}"`);
      expect(schema).toContain(`'${table}'`);
    }
  });

  it('pins provenance, forbids non-safe rows, and enforces one ACTIVE finding per lead+category', () => {
    expect(migration).toContain("CHECK (provenance = 'DETERMINISTIC_OPERATOR_APPROVED')");
    expect(migration).toContain("CHECK (safe_for_outreach = true)");
    expect(migration).toContain("CHECK (status IN ('ACTIVE','SUPERSEDED'))");
    expect(migration).toContain('deterministic_findings_active_uk');
    expect(migration).toContain(`WHERE "status" = 'ACTIVE'`);
  });

  it('does not touch the AI audit tables or any email/gmail/sending schema', () => {
    for (const forbidden of ['audit_runs', 'audit_findings', 'audit_reviews', 'email_drafts', 'gmail_drafts', 'send_attempts']) {
      expect(migration).not.toContain(forbidden);
    }
  });

  it('links finding evidence to real capture_evidence rows', () => {
    expect(migration).toContain('REFERENCES "capture_evidence"("id")');
  });
});
