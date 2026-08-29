import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../../migrations/0023_demo_engine_v2_foundation.sql', import.meta.url), 'utf8');
const down = readFileSync(new URL('../../scripts/rollback/0023_demo_engine_v2_foundation_down.sql', import.meta.url), 'utf8');
const repository = readFileSync(new URL('../../src/persistence/repositories/demo-v2-foundation.repo.ts', import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../migrations/meta/_journal.json', import.meta.url), 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};

const tables = [...migration.matchAll(/CREATE TABLE "(demo_v2_[^"]+)"/g)].map((match) => match[1]);

describe('migration 0023 Demo Engine V2 foundation', () => {
  it('is the single monotonic journal entry 23', () => {
    const matching = journal.entries.filter((entry) => entry.tag === '0023_demo_engine_v2_foundation');
    expect(matching).toHaveLength(1);
    expect(matching[0]?.idx).toBe(23);
    // Milestone 3B1 adds 0024 after it; 0023 must remain monotonic against its own predecessor (22).
    const predecessor = journal.entries.find((entry) => entry.idx === 22);
    expect((matching[0]?.when ?? 0) > (predecessor?.when ?? Number.MAX_SAFE_INTEGER)).toBe(true);
    // 0025 is the last Demo V2 migration; later phases append 0026 (outreach tracking),
    // 0027 (delivery events), 0028 (delivery corrections), 0029 (competitor research),
    // 0030 (competitor evidence capture), 0031 (competitor pattern packages),
    // 0032 (email competitor enrichment), 0033 (places_website_identity signal),
    // 0034 (deterministic outreach-finding bridge), 0035 (email authorship),
    // 0036 (reply email finalization), 0037 (outreach message gmail idempotency),
    // 0038 (scheduled send automation), and 0039 (contact enrichment) as the tail.
    const demoV2Entries = journal.entries.filter((entry) => entry.tag.startsWith('00') && entry.tag.includes('demo_v2'));
    expect(demoV2Entries.at(-1)?.tag).toBe('0025_demo_v2_visual_reviews');
    expect(journal.entries.at(-1)?.tag).toBe('0039_contact_enrichment');
  });

  it('creates exactly the 21 isolated approved V2 tables and changes no V1 table', () => {
    expect(new Set(tables).size).toBe(21);
    expect(tables).toContain('demo_v2_artifacts');
    expect(tables).toContain('demo_v2_approval_decisions');
    expect(tables).toContain('demo_v2_approval_invalidations');
    expect(migration).not.toMatch(/\bALTER TABLE\b/i);
    expect(migration).not.toMatch(/\b(TRUNCATE|DELETE\s+FROM|UPDATE\s+|DROP\s+TABLE)\b/i);
    expect(migration).not.toMatch(/REFERENCES "demos"/);
  });

  it('locks in human translation and asset-reuse approvals', () => {
    expect(migration).toContain('"review_actor_type" text');
    expect(migration).toContain('"review_actor_id" text');
    expect(migration).toContain("review_actor_type = 'HUMAN'");
    expect(migration).toContain("status IN ('PROPOSED','REUSE_REVIEW_REQUIRED','SELECTED','REJECTED','STALE')");
    expect(migration).not.toContain("'APPROVED','REJECTED','STALE'");
    expect(migration).toContain("decision NOT IN ('APPROVED_CONCEPT_USE','REJECTED') OR actor_type = 'HUMAN'");
  });

  it('binds approval packages and review decisions to rubric and visual hashes', () => {
    for (const column of [
      'quality_rubric_version', 'quality_rubric_hash', 'visual_review_set_hash',
      'category_scores', 'bound_visual_review_set_hash', 'bound_quality_rubric_hash',
    ]) expect(migration).toContain(`"${column}"`);
    expect(migration).toContain('score >= 85');
    expect(migration).toContain('blocker_count = 0');
    expect(repository).toContain('assertRequiredCategoryScores');
  });

  it('has a guarded reverse that refuses populated tables and drops only V2 tables', () => {
    expect(down).toContain('demo_v2_foundation_down_refused:table_not_empty');
    expect((down.match(/DROP TABLE "demo_v2_/g) ?? [])).toHaveLength(21);
    expect(down).not.toMatch(/DROP TABLE "(?!demo_v2_)/);
    expect(down).not.toMatch(/\b(TRUNCATE|DELETE\s+FROM)\b/i);
  });
});
