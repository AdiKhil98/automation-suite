import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../../migrations/0035_email_authorship.sql', import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../migrations/meta/_journal.json', import.meta.url), 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};
const schema = readFileSync(new URL('../../src/persistence/schema.ts', import.meta.url), 'utf8');

describe('migration 0035 (email authorship) metadata and safety', () => {
  it('is registered exactly once at its monotonic journal position (0035 is next unused)', () => {
    const matching = journal.entries.filter((e) => e.tag === '0035_email_authorship');
    expect(matching).toHaveLength(1);
    expect(matching[0]?.idx).toBe(35);
    expect(journal.entries[35]?.tag).toBe('0035_email_authorship');
    expect((matching[0]?.when ?? 0) > (journal.entries[34]?.when ?? Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('is additive only (no destructive statements)', () => {
    const executableDestruction = /\b(DROP|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE\s+[^;]+\s+(DROP|RENAME|TYPE))\b/i;
    expect(migration).not.toMatch(executableDestruction);
  });

  it('adds a NOT NULL authorship column defaulting to AI with a two-value CHECK', () => {
    expect(migration).toContain('ALTER TABLE "email_drafts" ADD COLUMN "authorship" text DEFAULT \'AI\' NOT NULL');
    expect(migration).toContain("CHECK (\"authorship\" IN ('AI','OPERATOR'))");
    // Schema mirrors it (default AI so existing rows stay AI-authored).
    expect(schema).toMatch(/authorship:\s*text\('authorship'\)\.notNull\(\)\.default\('AI'\)/);
    expect(schema).toContain('email_draft_authorship_ck');
  });

  it('touches only email_drafts (no audit/gmail/send/finding tables)', () => {
    for (const forbidden of ['audit_runs', 'audit_findings', 'gmail_drafts', 'send_attempts', 'deterministic_findings']) {
      expect(migration).not.toContain(forbidden);
    }
    expect(migration).toContain('"email_drafts"');
  });
});
