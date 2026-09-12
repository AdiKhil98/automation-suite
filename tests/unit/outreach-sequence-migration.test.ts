import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../../migrations/0044_outreach_sequence_followup_3.sql', import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../migrations/meta/_journal.json', import.meta.url), 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};
const schema = readFileSync(new URL('../../src/persistence/schema.ts', import.meta.url), 'utf8');

const TAG = '0044_outreach_sequence_followup_3';

/**
 * The executable SQL only. The file's header comment deliberately DISCUSSES what the migration does
 * not do (e.g. "there is no FOLLOW_UP_4"), so assertions about what the migration EXECUTES must not
 * read the prose.
 */
const sql = migration
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('migration 0044 (outreach sequence: final follow-up + provenance) metadata and safety', () => {
  it('is registered exactly once at its monotonic journal position (0044 is next unused)', () => {
    const matching = journal.entries.filter((e) => e.tag === TAG);
    expect(matching).toHaveLength(1);
    expect(matching[0]?.idx).toBe(44);
    expect(journal.entries[44]?.tag).toBe(TAG);
    expect((matching[0]?.when ?? 0) > (journal.entries[43]?.when ?? Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('is additive: it drops no table, column, index, or data', () => {
    // Checked against the EXECUTABLE sql: the header comment spells out the rollback, which
    // necessarily mentions DROP COLUMN without the migration ever performing one.
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN|INDEX)/i);
    expect(sql).not.toMatch(/\b(TRUNCATE|DELETE\s+FROM)\b/i);
    // The only DROPs are of the two CHECK constraints being WIDENED, immediately re-added.
    const drops = [...sql.matchAll(/ALTER TABLE "[^"]+" DROP CONSTRAINT "([^"]+)";/g)].map((m) => m[1]);
    expect(drops).toEqual(['outreach_record_status_ck', 'outreach_followup_step_ck']);
    for (const name of drops) {
      expect(sql).toContain(`ADD CONSTRAINT "${name ?? ''}" CHECK`);
    }
  });

  it('widens the record status check to include the final follow-up and nothing beyond it', () => {
    expect(migration).toContain("'FOLLOW_UP_3_DUE','FOLLOW_UP_3_SENT'");
    // Every pre-existing status survives, so no stored row can become invalid.
    for (const kept of [
      'DRAFT_READY', 'AWAITING_APPROVAL', 'APPROVED_TO_SEND', 'INITIAL_SENT',
      'FOLLOW_UP_1_DUE', 'FOLLOW_UP_1_SENT', 'FOLLOW_UP_2_DUE', 'FOLLOW_UP_2_SENT',
      'REPLIED_POSITIVE', 'REPLIED_NEUTRAL', 'REPLIED_NEGATIVE', 'BOUNCED',
      'UNSUBSCRIBED', 'DO_NOT_CONTACT', 'MEETING_BOOKED', 'CLOSED_WON', 'CLOSED_LOST',
    ]) {
      expect(migration).toContain(`'${kept}'`);
    }
    // The sequence is four emails total: no step-4 status is ever executed into the constraint.
    expect(sql).not.toContain('FOLLOW_UP_4');
  });

  it('widens the follow-up step check to 1-3 only', () => {
    expect(sql).toContain('"step" IN (1,2,3)');
    expect(sql).not.toContain('IN (1,2,3,4)');
  });

  it('adds sequence provenance to email_drafts with a backward-compatible default', () => {
    // Default 0 = INITIAL, which is exactly what every pre-existing draft was.
    expect(migration).toContain('ADD COLUMN "sequence_step" integer DEFAULT 0 NOT NULL');
    expect(migration).toContain('ADD COLUMN "outreach_record_id" text');
    expect(migration).toContain('"sequence_step" BETWEEN 0 AND 3');
  });

  it('documents an explicit rollback', () => {
    expect(migration).toContain('Rollback');
    expect(migration).toContain('DROP COLUMN "sequence_step"');
  });

  it('the schema mirrors the migration', () => {
    expect(schema).toContain("'FOLLOW_UP_3_DUE','FOLLOW_UP_3_SENT'");
    expect(schema).toContain("sql`${t.step} IN (1,2,3)`");
    expect(schema).toContain("sequenceStep: integer('sequence_step').notNull().default(0)");
    expect(schema).toContain("outreachRecordId: text('outreach_record_id')");
    expect(schema).toContain('email_draft_sequence_step_ck');
  });
});
