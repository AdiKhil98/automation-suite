import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Write a file atomically: full contents to a sibling temp file, then a rename over the target.
 * `rename` within one directory is atomic on both POSIX and Windows, so a crash or an interrupted run
 * can never leave a half-written file behind — a reader sees either the old contents or the new ones.
 *
 * Used for the local decision-maker state files (candidates.json, results.json), where a truncated
 * write would fail closed on the next read and, for candidates.json, could lose already-paid-for
 * extraction results.
 */
export function writeFileAtomicSync(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, contents, 'utf8');
  renameSync(tmp, path);
}
