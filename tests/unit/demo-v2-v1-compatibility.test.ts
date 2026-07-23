import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const deployCommand = readFileSync(new URL('../../src/cli/commands/deploy-demos.ts', import.meta.url), 'utf8');
const deployRepository = readFileSync(new URL('../../src/persistence/repositories/deploy-input.repo.ts', import.meta.url), 'utf8');
const reviewService = readFileSync(new URL('../../src/domain/review/review-service.ts', import.meta.url), 'utf8');
const schema = readFileSync(new URL('../../src/persistence/schema.ts', import.meta.url), 'utf8');

describe('Demo Engine V2 Milestone 1 V1 compatibility', () => {
  it('does not route V1 review or deployment through V2 tables', () => {
    for (const source of [deployCommand, deployRepository, reviewService]) {
      expect(source).not.toMatch(/demoV2|demo_v2/i);
    }
  });

  it('keeps the V1 demos schema and statuses unchanged', () => {
    expect(schema).toContain("export const demos = pgTable(");
    expect(schema).toContain("'GENERATED_PENDING_REVIEW','APPROVED','REJECTED','SUPERSEDED','BUILD_FAILED'");
    expect(schema).not.toMatch(/demoV2Artifacts[\s\S]{0,500}references\(\(\) => demos\.id/);
  });
});
