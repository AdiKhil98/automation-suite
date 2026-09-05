import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OPERATIONAL_DECISION_MAKER_FILES } from '../support/local-data-isolation.js';

/**
 * Source-level guard against the leak returning.
 *
 * `discover-decision-makers` and `decision-makers-rerank` both default their local state files to
 * operator-owned paths under `.local-data/decision-makers/`. Tests supplied `--out` but inherited the
 * real `--results` default, so every --confirm test wrote mock records into the operational manifest.
 * Runtime guards (`guardOperationalLocalData`) catch a leak only when the operational file happens to
 * exist on that machine; this test catches the mistake in the source itself, everywhere, always.
 */

const TESTS_ROOT = fileURLToPath(new URL('..', import.meta.url));

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...testFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

// This guard names the symbols it polices, so it must not police itself.
const ALL_TEST_FILES = testFiles(TESTS_ROOT).filter((f) => !f.endsWith('decision-makers-test-isolation.test.ts'));
const read = (f: string): string => readFileSync(f, 'utf8');
const rel = (f: string): string => f.slice(TESTS_ROOT.length).replace(/\\/g, '/');

describe('decision-maker tests cannot touch operator-owned .local-data state', () => {
  it('discoverDecisionMakersCommand is invoked from exactly one place, and that place injects a temp results path', () => {
    const callers = ALL_TEST_FILES.filter((f) => /discoverDecisionMakersCommand\s*\(/.test(read(f)));
    expect(callers.map(rel)).toEqual(['integration/discover-decision-makers.pg.test.ts']);

    const src = read(callers[0]!);
    const calls = [...src.matchAll(/discoverDecisionMakersCommand\s*\(/g)];
    expect(calls, 'every test must go through the runDiscover wrapper').toHaveLength(1);
    expect(src).toContain('return discoverDecisionMakersCommand(context, { ...opts, results: tmpResults }, deps);');
  });

  it('no test hard-codes an operational decision-maker path as a write target', () => {
    for (const file of ALL_TEST_FILES) {
      // The isolation helper legitimately names the paths in order to protect them.
      if (/local-data-isolation/.test(file)) continue;
      for (const operational of OPERATIONAL_DECISION_MAKER_FILES) {
        expect(read(file), `${rel(file)} must not reference ${operational}`).not.toContain(operational);
      }
    }
  });

  it('every decision-maker test that can reach a .local-data default installs the runtime guard', () => {
    const needsGuard = ALL_TEST_FILES.filter((f) => /discoverDecisionMakersCommand\s*\(|decisionMakersRerankCommand\s*\(/.test(read(f)));
    expect(needsGuard.length).toBeGreaterThan(0);
    for (const file of needsGuard) {
      expect(read(file), `${rel(file)} must call guardOperationalLocalData()`).toContain('guardOperationalLocalData()');
    }
  });
});
