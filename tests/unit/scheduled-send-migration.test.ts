import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../../migrations/0038_scheduled_send_automation.sql', import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../migrations/meta/_journal.json', import.meta.url), 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};
const schema = readFileSync(new URL('../../src/persistence/schema.ts', import.meta.url), 'utf8');

describe('migration 0038 (scheduled send automation) metadata and safety', () => {
  it('is registered exactly once at its monotonic journal position (0038 is next unused)', () => {
    const matching = journal.entries.filter((e) => e.tag === '0038_scheduled_send_automation');
    expect(matching).toHaveLength(1);
    expect(matching[0]?.idx).toBe(38);
    expect(journal.entries[38]?.tag).toBe('0038_scheduled_send_automation');
    expect((matching[0]?.when ?? 0) > (journal.entries[37]?.when ?? Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('drops no table/column and deletes no data; the ONLY drop is the readiness index, immediately recreated (safe, scoped)', () => {
    expect(migration).not.toMatch(/DROP\s+TABLE/i);
    expect(migration).not.toMatch(/DROP\s+COLUMN/i);
    expect(migration).not.toMatch(/\b(TRUNCATE|DELETE\s+FROM)\b/i);
    // The migration is NOT strictly additive: it drops exactly one index and recreates it in the same
    // migration, widened to include `source` (existing rows are all INTERACTIVE, so the recreate cannot
    // raise a uniqueness violation — verified in the migration header).
    const dropCount = (migration.match(/DROP\s+INDEX/gi) ?? []).length;
    expect(dropCount).toBe(1);
    expect(migration).toContain('DROP INDEX "sending_readiness_active_uk"');
    expect(migration).toContain('CREATE UNIQUE INDEX "sending_readiness_active_uk" ON "sending_readiness_approvals" ("gmail_account","policy_version","source")');
    // The header must NOT claim the migration is strictly additive-only.
    expect(migration).toMatch(/NOT strictly additive/i);
  });

  it('creates the durable authorization table with a bounded 14-day window + positive cap checks', () => {
    expect(migration).toContain('CREATE TABLE "scheduled_send_authorizations"');
    expect(migration).toContain(`CHECK ("max_per_day" >= 1)`);
    expect(migration).toContain(`interval '14 days'`);
    expect(migration).toContain('CREATE UNIQUE INDEX "scheduled_send_auth_active_uk"');
  });

  it('adds readiness provenance so INTERACTIVE (manual) and SCHEDULED (automated) lineages are separated', () => {
    expect(migration).toContain('ADD COLUMN "source" text DEFAULT \'INTERACTIVE\' NOT NULL');
    expect(migration).toContain('ADD COLUMN "scheduled_authorization_id" text');
    expect(migration).toContain('"sending_readiness_source_ck"');
    // The schema mirrors both.
    expect(schema).toContain('scheduled_send_authorizations');
    expect(schema).toMatch(/source:\s*text\('source'\)\.notNull\(\)\.default\('INTERACTIVE'\)/);
  });
});
