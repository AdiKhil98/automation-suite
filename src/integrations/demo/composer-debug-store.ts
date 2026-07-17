import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Default retention for composer diagnostics records (7 days). */
export const COMPOSER_DEBUG_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Diagnostic record of ONE composer run — written for EVERY run (composed, rejected, or
 * failed) so the generated design spec and the reviewer's verdict are always inspectable.
 * Contains ONLY structured (schema-shaped) data: the spec the model produced and the
 * reviewer verdict. NEVER the API key, hidden reasoning/chain-of-thought, or rendered HTML.
 */
export interface ComposerDebugRecord {
  leadId: string;
  runId: string;
  outcome: string;
  /** The parsed design spec, or null when the generator output never parsed. */
  spec: unknown | null;
  /** The parsed reviewer verdict, or null when no reviewer verdict was produced. */
  review: unknown | null;
  /** Deterministic validation violations, when the spec/render was rejected in code. */
  violations: string[];
  costUsd: number;
  callsMade: number;
  createdAt: string;
  expiresAt: string;
}

export interface ComposerDebugStore {
  record(rec: ComposerDebugRecord): Promise<void>;
}

/**
 * Local FS composer diagnostics store. Files are git-ignored, written atomically with
 * restrictive (0600) permissions, and carry an expiry. Unlike the audit debug store this
 * records SUCCESSFUL runs too, so every spec + reviewer verdict is retained for review.
 */
export class LocalComposerDebugStore implements ComposerDebugStore {
  constructor(
    private readonly dir: string,
    private readonly ttlMs: number = COMPOSER_DEBUG_TTL_MS,
  ) {}

  private file(rec: ComposerDebugRecord): string {
    const ts = rec.createdAt.replace(/[:.]/g, '-');
    return `${rec.leadId}-${ts}-${rec.outcome}.json`;
  }

  async record(rec: ComposerDebugRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const name = this.file(rec);
    const tmp = join(this.dir, `${name}.tmp`);
    await writeFile(tmp, JSON.stringify(rec, null, 2), { mode: 0o600 });
    await rename(tmp, join(this.dir, name));
  }

  /** Remove expired records. Returns the count removed. */
  async cleanupExpired(now: Date = new Date()): Promise<number> {
    if (!existsSync(this.dir)) return 0;
    let removed = 0;
    for (const f of await readdir(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(await readFile(join(this.dir, f), 'utf8')) as ComposerDebugRecord;
        if (new Date(rec.expiresAt).getTime() <= now.getTime()) {
          await rm(join(this.dir, f), { force: true });
          removed += 1;
        }
      } catch {
        /* skip unreadable */
      }
    }
    return removed;
  }

  expiryFrom(now: Date = new Date()): string {
    return new Date(now.getTime() + this.ttlMs).toISOString();
  }
}
