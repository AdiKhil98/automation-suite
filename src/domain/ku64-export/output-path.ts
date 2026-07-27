import path from 'node:path';
import { Ku64ExportError } from './types.js';

/** The one and only directory tree the exporter may write into (relative to repo root). */
export const KU64_LOCAL_DATA_SUBDIR = path.join('.local-data', 'ku64-v2');
export const KU64_EVIDENCE_FILENAME = 'evidence.json';

/**
 * Resolve the fixed evidence output path under `<repoRoot>/.local-data/ku64-v2/` and
 * assert it stays within that directory. Fails closed on any attempt (via symlink,
 * `..`, or an absolute override) to escape the allowed tree.
 */
export function resolveEvidenceOutputPath(repoRoot: string, candidate?: string): string {
  const allowedDir = path.resolve(repoRoot, KU64_LOCAL_DATA_SUBDIR);
  const resolved =
    candidate === undefined
      ? path.join(allowedDir, KU64_EVIDENCE_FILENAME)
      : path.resolve(repoRoot, candidate);

  assertWithinLocalData(resolved, repoRoot);
  return resolved;
}

/** Throw unless `resolvedPath` is inside `<repoRoot>/.local-data/ku64-v2/`. */
export function assertWithinLocalData(resolvedPath: string, repoRoot: string): void {
  const allowedDir = path.resolve(repoRoot, KU64_LOCAL_DATA_SUBDIR);
  const rel = path.relative(allowedDir, resolvedPath);
  const escapes = rel === '' || rel.startsWith('..') || path.isAbsolute(rel);
  if (escapes) {
    throw new Ku64ExportError(
      'output_path_outside_local_data',
      `output path must be inside ${KU64_LOCAL_DATA_SUBDIR}: ${resolvedPath}`,
    );
  }
}
