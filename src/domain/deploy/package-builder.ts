import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type DeployFile, type DeployPackage } from '../../integrations/netlify/provider.js';
import { validateRenderedHtml } from '../demo/demo-validation.js';

/** The ONLY files that may be deployed. Composer demos are fully self-contained (inline CSS +
 * SVG), so no external static assets are needed for the MVP. */
export const DEPLOY_ALLOWLIST = new Set(['index.html', 'netlify.toml']);

export interface PackageOptions {
  maxBytes: number;
  maxFiles: number;
  /** The approved demo's stored content hash (used as the artifact hash). */
  artifactHash: string;
}

export interface PackageResult {
  ok: boolean;
  violations: string[];
  pkg?: DeployPackage;
  /** The index.html contents (for post-deploy byte-exact verification). */
  indexHtml?: string;
}

const sha1 = (b: Buffer): string => createHash('sha1').update(b).digest('hex');

/**
 * Build the deploy package from a demo directory, applying a strict allowlist and rejecting
 * symlinks, path traversal, hidden/debug/source-map/unexpected files, oversized archives, and
 * anything the vetted renderer would not produce (scripts/forms/external/trackers via the
 * shared HTML security check). Fail-closed: any problem yields no package.
 */
export async function buildDeployPackage(demoDir: string, opts: PackageOptions): Promise<PackageResult> {
  const violations: string[] = [];
  const base = resolve(demoDir);

  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return { ok: false, violations: ['demo_dir_unreadable'] };
  }

  const names: string[] = [];
  for (const e of entries) {
    const name = e.name;
    if (name.includes('/') || name.includes('\\') || name.includes('..')) { violations.push(`unsafe_name:${name}`); continue; }
    if (e.isSymbolicLink()) { violations.push(`symlink:${name}`); continue; }
    if (!e.isFile()) { violations.push(`unexpected_entry:${name}`); continue; }
    if (name.startsWith('.')) { violations.push(`hidden_file:${name}`); continue; }
    if (/\.map$/i.test(name)) { violations.push(`source_map:${name}`); continue; }
    if (!DEPLOY_ALLOWLIST.has(name)) { violations.push(`unexpected_file:${name}`); continue; }
    names.push(name);
  }
  if (!names.includes('index.html')) violations.push('missing_index');
  if (violations.length > 0) return { ok: false, violations };

  const files: DeployFile[] = [];
  let totalBytes = 0;
  let indexHtml = '';
  for (const name of names.sort()) {
    const full = join(base, name);
    // Defence in depth: re-stat and refuse symlinks that appeared between readdir and read.
    const st = await lstat(full);
    if (st.isSymbolicLink() || !st.isFile()) { violations.push(`unsafe_at_read:${name}`); continue; }
    const content = await readFile(full);
    totalBytes += content.length;
    if (name === 'index.html') indexHtml = content.toString('utf8');
    files.push({ path: `/${name}`, content, sha1: sha1(content) });
  }
  if (violations.length > 0) return { ok: false, violations };

  if (totalBytes > opts.maxBytes) violations.push(`too_large:${String(totalBytes)}`);
  if (files.length > opts.maxFiles) violations.push(`too_many_files:${String(files.length)}`);

  // The deployed index.html must pass the same security checks as the local render.
  const contentCheck = validateRenderedHtml(indexHtml);
  for (const c of contentCheck.violations) violations.push(`content:${c}`);

  if (violations.length > 0) return { ok: false, violations };

  return {
    ok: true,
    violations: [],
    pkg: { files, totalBytes, fileCount: files.length, artifactHash: opts.artifactHash },
    indexHtml,
  };
}
