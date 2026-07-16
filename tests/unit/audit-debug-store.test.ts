import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AUDIT_DEBUG_TTL_MS, LocalAuditDebugStore, type AuditDebugEnvelope } from '../../src/integrations/audit/debug-store.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'dbgstore-'));
  dirs.push(d);
  return d;
}

function env(over: Partial<AuditDebugEnvelope> = {}): AuditDebugEnvelope {
  const now = new Date();
  return {
    auditRunId: 'run-1',
    leadId: 'lead-1',
    responseId: 'resp-1',
    stage: 'validation_failed',
    attempt: 0,
    findingRefs: ['F1'],
    violations: [{ code: 'forbidden_claim:numeric_percentage:F1', message: 'forbidden claim' }],
    rawOutput: { findings: [{ findingRef: 'F1' }] },
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + AUDIT_DEBUG_TTL_MS).toISOString(),
    ...over,
  };
}

describe('LocalAuditDebugStore', () => {
  it('writes with restrictive (0600) permissions', async () => {
    const dir = await tmp();
    const store = new LocalAuditDebugStore(dir);
    await store.record(env());
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
    const s = await stat(join(dir, files[0] as string));
    // Owner rw only (mask 0o777). Skip the assertion on Windows where POSIX bits differ.
    if (process.platform !== 'win32') expect(s.mode & 0o777).toBe(0o600);
    expect(files.length).toBe(1);
  });

  it('cleanupExpired removes only past-expiry records', async () => {
    const dir = await tmp();
    const store = new LocalAuditDebugStore(dir);
    await store.record(env({ auditRunId: 'fresh', expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    await store.record(env({ auditRunId: 'stale', expiresAt: new Date(Date.now() - 60_000).toISOString() }));
    const removed = await store.cleanupExpired();
    expect(removed).toBe(1);
    const left = (await readdir(dir)).filter((f) => f.endsWith('.json'));
    expect(left).toHaveLength(1);
    expect(left[0]).toContain('fresh');
  });

  it('archiveForRun moves a run\'s records into archive/', async () => {
    const dir = await tmp();
    const store = new LocalAuditDebugStore(dir);
    await store.record(env({ auditRunId: 'run-A', attempt: 0 }));
    await store.record(env({ auditRunId: 'run-B', attempt: 0 }));
    await store.archiveForRun('run-A');
    expect((await readdir(dir)).filter((f) => f.endsWith('.json'))).toHaveLength(1); // run-B remains
    expect((await readdir(join(dir, 'archive'))).filter((f) => f.endsWith('.json'))).toHaveLength(1); // run-A archived
  });

  it('purgeAll removes active and archived records', async () => {
    const dir = await tmp();
    const store = new LocalAuditDebugStore(dir);
    await store.record(env({ auditRunId: 'run-A' }));
    await store.archiveForRun('run-A');
    await store.record(env({ auditRunId: 'run-B' }));
    const removed = await store.purgeAll();
    expect(removed).toBe(2);
  });
});
