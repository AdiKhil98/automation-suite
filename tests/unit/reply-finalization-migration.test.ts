import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../../migrations/0036_reply_email_finalization.sql', import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../migrations/meta/_journal.json', import.meta.url), 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};
const schema = readFileSync(new URL('../../src/persistence/schema.ts', import.meta.url), 'utf8');

describe('migration 0036 (reply email finalization) metadata and safety', () => {
  it('is registered exactly once at its monotonic journal position (0036 is next unused)', () => {
    const matching = journal.entries.filter((e) => e.tag === '0036_reply_email_finalization');
    expect(matching).toHaveLength(1);
    expect(matching[0]?.idx).toBe(36);
    expect(journal.entries[36]?.tag).toBe('0036_reply_email_finalization');
    expect((matching[0]?.when ?? 0) > (journal.entries[35]?.when ?? Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('only loosens NOT NULL + adds — it never removes a column/table or deletes data', () => {
    // Loosening NOT NULL legitimately contains "DROP NOT NULL"; but no column/table drop or row deletion.
    expect(migration).not.toMatch(/DROP\s+TABLE/i);
    expect(migration).not.toMatch(/DROP\s+COLUMN/i);
    expect(migration).not.toMatch(/\b(TRUNCATE|DELETE\s+FROM)\b/i);
    expect(migration).toContain('ALTER COLUMN "deployment_run_id" DROP NOT NULL');
    expect(migration).toContain('ALTER COLUMN "verified_deployment_url" DROP NOT NULL');
  });

  it('adds the kind discriminator (default DEMO_URL_RESOLVED) + CHECK + reply partial unique index', () => {
    expect(migration).toContain('ADD COLUMN "kind" text DEFAULT \'DEMO_URL_RESOLVED\' NOT NULL');
    expect(migration).toContain("CHECK (\"kind\" IN ('DEMO_URL_RESOLVED','REPLY_DIRECT'))");
    expect(migration).toContain('CREATE UNIQUE INDEX "email_draft_finalizations_reply_uk"');
    expect(migration).toContain(`WHERE "kind" = 'REPLY_DIRECT'`);
    // Schema mirrors it; default keeps every existing finalization a demo finalization.
    expect(schema).toMatch(/kind:\s*text\('kind'\)\.notNull\(\)\.default\('DEMO_URL_RESOLVED'\)/);
    expect(schema).toContain('email_draft_finalizations_reply_uk');
  });

  it('touches only email_draft_finalizations (no other table, no gmail/send tables)', () => {
    for (const forbidden of ['gmail_drafts', 'send_attempts', 'send_schedules', 'email_drafts"', 'leads"']) {
      expect(migration).not.toContain(forbidden);
    }
    expect(migration).toContain('"email_draft_finalizations"');
  });
});
