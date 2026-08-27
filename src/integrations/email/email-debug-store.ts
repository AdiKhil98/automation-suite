import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const EMAIL_DEBUG_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Diagnostic record of ONE email run — written for EVERY run (drafted, rejected, or failed)
 * so the drafted email and the reviewer verdict are always inspectable. Structured data
 * ONLY: NEVER the API key, hidden reasoning, or recipient PII beyond the drafted content.
 */
export interface EmailDebugRecord {
  leadId: string;
  runId: string;
  outcome: string;
  draft: unknown | null;
  review: unknown | null;
  violations: string[];
  costUsd: number;
  callsMade: number;
  createdAt: string;
  expiresAt: string;
}

export interface EmailDebugStore {
  record(rec: EmailDebugRecord): Promise<void>;
}

/** Read side of the debug store: the reviewer-only resume path reloads the exact original
 * writer output (which the DB does not persist) from the diagnostic record written at draft time. */
export interface EmailDebugReader {
  findByLeadAndRun(leadId: string, runId: string | null): Promise<EmailDebugRecord | null>;
}

/** Local FS email diagnostics store. Git-ignored, atomic, 0600, expiring. Records SUCCESS
 * runs too, so every drafted email + reviewer verdict is retained for review. */
export class LocalEmailDebugStore implements EmailDebugStore, EmailDebugReader {
  constructor(
    private readonly dir: string,
    private readonly ttlMs: number = EMAIL_DEBUG_TTL_MS,
  ) {}

  async record(rec: EmailDebugRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const name = `${rec.leadId}-${rec.createdAt.replace(/[:.]/g, '-')}-${rec.outcome}.json`;
    const tmp = join(this.dir, `${name}.tmp`);
    await writeFile(tmp, JSON.stringify(rec, null, 2), { mode: 0o600 });
    await rename(tmp, join(this.dir, name));
  }

  /**
   * Reload the diagnostic record for a specific (lead, run). Returns the record whose draft is
   * present (a failed/rejected run always retains the full writer output), or null if no readable
   * record matches. Expiry is NOT enforced here: a still-present record is usable for resume even
   * near its TTL; cleanup is a separate concern.
   */
  async findByLeadAndRun(leadId: string, runId: string | null): Promise<EmailDebugRecord | null> {
    if (!existsSync(this.dir)) return null;
    const prefix = `${leadId}-`;
    let best: EmailDebugRecord | null = null;
    for (const f of await readdir(this.dir)) {
      if (!f.startsWith(prefix) || !f.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(await readFile(join(this.dir, f), 'utf8')) as EmailDebugRecord;
        if (rec.leadId !== leadId || rec.runId !== runId || rec.draft === null) continue;
        if (best === null || rec.createdAt > best.createdAt) best = rec;
      } catch {
        /* skip unreadable */
      }
    }
    return best;
  }

  async cleanupExpired(now: Date = new Date()): Promise<number> {
    if (!existsSync(this.dir)) return 0;
    let removed = 0;
    for (const f of await readdir(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(await readFile(join(this.dir, f), 'utf8')) as EmailDebugRecord;
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
