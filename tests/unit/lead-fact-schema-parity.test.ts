import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FACT_TYPES } from '../../src/domain/lead-facts/lead-fact.js';

const migration = readFileSync(new URL('../../migrations/0022_restore_demo_fact_types.sql', import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../migrations/meta/_journal.json', import.meta.url), 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};
const schema = readFileSync(new URL('../../src/persistence/schema.ts', import.meta.url), 'utf8');

describe('migration 0022 lead-fact schema parity', () => {
  it('is registered exactly once at its monotonic journal position', () => {
    const matching = journal.entries.filter((entry) => entry.tag === '0022_restore_demo_fact_types');
    expect(matching).toHaveLength(1);
    expect(matching[0]?.idx).toBe(22);
    expect(journal.entries[22]?.tag).toBe('0022_restore_demo_fact_types');
    expect((matching[0]?.when ?? 0) > (journal.entries[21]?.when ?? Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('restores every established demo fact type in code and the database constraint', () => {
    for (const factType of ['services', 'opening_hours', 'booking_url'] as const) {
      expect(FACT_TYPES).toContain(factType);
      expect(schema).toContain(`'${factType}'`);
      expect(migration).toContain(`'${factType}'`);
    }
    expect(migration).not.toMatch(/\b(TRUNCATE|DELETE\s+FROM|DROP\s+TABLE)\b/i);
  });
});
