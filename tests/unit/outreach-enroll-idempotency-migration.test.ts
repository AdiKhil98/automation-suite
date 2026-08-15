import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../../migrations/0037_outreach_message_gmail_idempotency.sql', import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../migrations/meta/_journal.json', import.meta.url), 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};
const schema = readFileSync(new URL('../../src/persistence/schema.ts', import.meta.url), 'utf8');

describe('migration 0037 (outreach message gmail idempotency) metadata and safety', () => {
  it('is registered exactly once at its monotonic journal position (0037 is next unused)', () => {
    const matching = journal.entries.filter((e) => e.tag === '0037_outreach_message_gmail_idempotency');
    expect(matching).toHaveLength(1);
    expect(matching[0]?.idx).toBe(37);
    expect(journal.entries[37]?.tag).toBe('0037_outreach_message_gmail_idempotency');
    expect((matching[0]?.when ?? 0) > (journal.entries[36]?.when ?? Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('adds ONLY a partial unique index on the non-null gmail_message_id — additive, no data loss', () => {
    expect(migration).not.toMatch(/DROP\s+(TABLE|COLUMN|INDEX)/i);
    expect(migration).not.toMatch(/\b(TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE)\b/i);
    expect(migration).toContain('CREATE UNIQUE INDEX "outreach_messages_gmail_message_uk"');
    expect(migration).toContain('ON "outreach_messages" ("gmail_message_id")');
    expect(migration).toContain('WHERE "gmail_message_id" IS NOT NULL');
  });

  it('touches only outreach_messages (no send/email/gmail tables)', () => {
    for (const forbidden of ['send_attempts', 'gmail_drafts', 'email_draft_finalizations', 'email_drafts', 'outreach_records', 'outreach_followups']) {
      expect(migration).not.toContain(forbidden);
    }
    expect(migration).toContain('"outreach_messages"');
  });

  it('the schema mirrors the partial unique index', () => {
    expect(schema).toContain('outreach_messages_gmail_message_uk');
    expect(schema).toMatch(/uniqueIndex\('outreach_messages_gmail_message_uk'\)\.on\(t\.gmailMessageId\)\.where/);
  });
});
