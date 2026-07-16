import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type AuditEnvelope, type EnvelopeStore } from '../../domain/audit/audit-service.js';

/**
 * Local recovery envelope store. Written atomically (temp file → rename) after a
 * completed audit, BEFORE DB persistence, so a failed DB write never repeats paid
 * model calls — `resume-audit` replays the persistence idempotently. Contains no API
 * keys, env, hidden reasoning, image bytes, full HTML, or Google-derived context.
 */
export class LocalEnvelopeStore implements EnvelopeStore {
  constructor(private readonly dir: string) {}

  private path(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  async save(env: AuditEnvelope): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = join(this.dir, `${env.idempotencyKey}.tmp`);
    await writeFile(tmp, JSON.stringify(env), { mode: 0o600 });
    await rename(tmp, this.path(env.idempotencyKey)); // atomic within the volume
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  async load(key: string): Promise<AuditEnvelope | null> {
    const p = this.path(key);
    if (!existsSync(p)) return null;
    return revive(JSON.parse(await readFile(p, 'utf8')) as AuditEnvelope);
  }

  async list(): Promise<AuditEnvelope[]> {
    if (!existsSync(this.dir)) return [];
    const out: AuditEnvelope[] = [];
    for (const file of await readdir(this.dir)) {
      if (!file.endsWith('.json')) continue;
      out.push(revive(JSON.parse(await readFile(join(this.dir, file), 'utf8')) as AuditEnvelope));
    }
    return out;
  }
}

/** JSON round-trip turns Dates into strings; restore them for DB replay. */
function revive(env: AuditEnvelope): AuditEnvelope {
  const run = env.persist.auditRun;
  run.startedAt = new Date(run.startedAt);
  run.completedAt = new Date(run.completedAt);
  return env;
}
