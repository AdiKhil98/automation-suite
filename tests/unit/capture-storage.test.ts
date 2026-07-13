import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalFsCaptureStorage } from '../../src/integrations/capture/local-fs-storage.js';
import { type Screenshot } from '../../src/domain/capture/capture-types.js';

function shot(byte: number): Screenshot {
  return { profile: 'desktop', kind: 'viewport', bytes: Buffer.from([byte, byte, byte]), mime: 'image/png', width: 1440, height: 900 };
}

describe('LocalFsCaptureStorage', () => {
  let dir: string;
  let store: LocalFsCaptureStorage;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'capstore-'));
    store = new LocalFsCaptureStorage(dir);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('stages, commits, and reads a content-addressed blob', async () => {
    const meta = await store.stage('run-1', shot(1), 0);
    await store.commitAll('run-1');
    expect(await store.read(meta.sha256)).not.toBeNull();
  });

  it('deduplicates identical bytes and keeps the shared blob under GC', async () => {
    const m1 = await store.stage('run-2', shot(1), 0); // same bytes as run-1
    await store.commitAll('run-2');
    const m2 = await store.stage('run-3', shot(2), 0); // distinct bytes
    await store.commitAll('run-3');
    expect(m1.sha256).not.toBe(m2.sha256);

    // GC with both referenced → nothing removed.
    expect(await store.gc(new Set([m1.sha256, m2.sha256]))).toBe(0);
    // GC with only the shared blob referenced → the other is removed, shared retained.
    const removed = await store.gc(new Set([m1.sha256]));
    expect(removed).toBe(1);
    expect(await store.read(m1.sha256)).not.toBeNull();
    expect(await store.read(m2.sha256)).toBeNull();
  });

  it('discards only its own temp files on failure', async () => {
    const meta = await store.stage('run-4', shot(9), 0);
    await store.discardTemp('run-4');
    // Not committed → blob must not exist.
    expect(await store.read(meta.sha256)).toBeNull();
  });
});
