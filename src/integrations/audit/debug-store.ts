import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Default retention for debug envelopes (7 days). */
export const AUDIT_DEBUG_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** One violation, code + human-readable message. Never includes model reasoning. */
export interface DebugViolation {
  code: string;
  message: string;
}

/**
 * Diagnostic record of a FAILED generator validation, so failed paid calls remain
 * diagnosable. Contains ONLY the structured (schema-shaped) generator output and the
 * validation verdict — never the API key, hidden reasoning/chain-of-thought,
 * screenshots, or full HTML.
 */
export interface AuditDebugEnvelope {
  auditRunId: string;
  leadId: string;
  responseId: string | null;
  stage: 'schema_invalid' | 'validation_failed';
  attempt: number;
  findingRefs: string[];
  violations: DebugViolation[];
  rawOutput: unknown; // structured generator JSON only (no reasoning/screenshots/HTML)
  createdAt: string;
  expiresAt: string;
}

export interface AuditDebugStore {
  record(env: AuditDebugEnvelope): Promise<void>;
  /** Move a run's debug envelopes to the archive after successful completion. */
  archiveForRun(auditRunId: string): Promise<void>;
}

/**
 * Local FS debug store. Files are git-ignored, written atomically with restrictive
 * (0600) permissions, carry an expiry, and are archived (not silently deleted) once
 * the run ultimately succeeds. `clean-audit-debug` removes expired records.
 */
export class LocalAuditDebugStore implements AuditDebugStore {
  private readonly archiveDir: string;
  constructor(
    private readonly dir: string,
    private readonly ttlMs: number = 7 * 24 * 60 * 60 * 1000,
  ) {
    this.archiveDir = join(dir, 'archive');
  }

  private file(env: AuditDebugEnvelope): string {
    return `${env.auditRunId}-a${String(env.attempt)}-${env.stage}.json`;
  }

  async record(env: AuditDebugEnvelope): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const name = this.file(env);
    const tmp = join(this.dir, `${name}.tmp`);
    await writeFile(tmp, JSON.stringify(env, null, 2), { mode: 0o600 });
    await rename(tmp, join(this.dir, name));
  }

  async archiveForRun(auditRunId: string): Promise<void> {
    if (!existsSync(this.dir)) return;
    await mkdir(this.archiveDir, { recursive: true });
    for (const f of await readdir(this.dir)) {
      if (f.startsWith(`${auditRunId}-`) && f.endsWith('.json')) {
        await rename(join(this.dir, f), join(this.archiveDir, f));
      }
    }
  }

  /** Read one active sanitized validation envelope. Never returns screenshots, HTML, or secrets. */
  async readActive(auditRunId: string, attempt: number): Promise<AuditDebugEnvelope | null> {
    if (!existsSync(this.dir)) return null;
    const expected = `${auditRunId}-a${String(attempt)}-validation_failed.json`;
    if (!(await readdir(this.dir)).includes(expected)) return null;
    try {
      const parsed = JSON.parse(await readFile(join(this.dir, expected), 'utf8')) as AuditDebugEnvelope;
      return parsed.auditRunId === auditRunId && parsed.attempt === attempt && parsed.stage === 'validation_failed'
        ? parsed
        : null;
    } catch {
      return null;
    }
  }

  /** Remove expired records from active + archive dirs. Returns the count removed. */
  async cleanupExpired(now: Date = new Date()): Promise<number> {
    let removed = 0;
    for (const d of [this.dir, this.archiveDir]) {
      if (!existsSync(d)) continue;
      for (const f of await readdir(d)) {
        if (!f.endsWith('.json')) continue;
        try {
          const env = JSON.parse(await readFile(join(d, f), 'utf8')) as AuditDebugEnvelope;
          if (new Date(env.expiresAt).getTime() <= now.getTime()) {
            await rm(join(d, f), { force: true });
            removed += 1;
          }
        } catch {
          /* skip unreadable */
        }
      }
    }
    return removed;
  }

  /** Remove ALL debug records (active + archive). Returns the count removed. */
  async purgeAll(): Promise<number> {
    let removed = 0;
    for (const d of [this.dir, this.archiveDir]) {
      if (!existsSync(d)) continue;
      for (const f of await readdir(d)) {
        if (!f.endsWith('.json')) continue;
        await rm(join(d, f), { force: true });
        removed += 1;
      }
    }
    return removed;
  }

  expiryFrom(now: Date = new Date()): string {
    return new Date(now.getTime() + this.ttlMs).toISOString();
  }
}
