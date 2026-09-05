import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect } from 'vitest';

/**
 * Operator-owned local state that the test suite must never create, modify or delete.
 *
 * `discover-decision-makers` defaults both of its state files to these paths. A test that supplies
 * only `--out` silently inherits the real `--results` default, which is how the suite came to write
 * mock extraction records into the operational manifest. The ids involved were throwaway UUIDs, but on
 * a machine holding genuine state the same run would mutate live idempotency data — and a manifest
 * record suppresses future PAID extraction, so corrupting it has real cost.
 */
export const OPERATIONAL_DECISION_MAKER_FILES = [
  '.local-data/decision-makers/candidates.json',
  '.local-data/decision-makers/results.json',
] as const;

/** `absent`, or a content hash — enough to detect creation, modification and deletion alike. */
function snapshot(paths: readonly string[]): string {
  return paths
    .map((p) => {
      if (!existsSync(p)) return `${p}=absent`;
      return `${p}=${createHash('sha256').update(readFileSync(p)).digest('hex')}`;
    })
    .join('\n');
}

/**
 * Install a whole-file guard: snapshot the operational files before any test runs, and assert they are
 * byte-identical (or still absent) afterwards. Call once at module scope in any test file that can
 * reach a command with a `.local-data` default.
 */
export function guardOperationalLocalData(paths: readonly string[] = OPERATIONAL_DECISION_MAKER_FILES): void {
  let before = '';
  beforeAll(() => { before = snapshot(paths); });
  afterAll(() => {
    expect(snapshot(paths), 'a test wrote to operator-owned .local-data state — pass an explicit temp path').toBe(before);
  });
}
