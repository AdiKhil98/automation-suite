import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type Screenshot } from '../../domain/capture/capture-types.js';
import { type ArtifactMeta, type CaptureStorageProvider } from './storage.js';

/**
 * Local filesystem storage. Temp: <base>/tmp/<runId>/<key>.png. Committed blobs:
 * <base>/blobs/<sha[0:2]>/<sha>.png (content-addressed, shared, deduplicated).
 * Paths use ids/hashes only — never lead names, URLs, or emails.
 */
export class LocalFsCaptureStorage implements CaptureStorageProvider {
  private readonly staged = new Map<string, ArtifactMeta[]>(); // runId → metas (with temp files)

  constructor(private readonly baseDir: string) {}

  private tmpDir(runId: string): string {
    return join(this.baseDir, 'tmp', runId);
  }
  private blobPath(sha: string): string {
    return join(this.baseDir, 'blobs', sha.slice(0, 2), `${sha}.png`);
  }
  private tmpPath(runId: string, key: string): string {
    return join(this.tmpDir(runId), `${key}.png`);
  }

  async stage(runId: string, shot: Screenshot, pageIndex: number): Promise<ArtifactMeta> {
    const sha = createHash('sha256').update(shot.bytes).digest('hex');
    const key = `${pageIndex}-${shot.profile}-${shot.kind}`;
    await mkdir(this.tmpDir(runId), { recursive: true });
    await writeFile(this.tmpPath(runId, key), shot.bytes);
    const meta: ArtifactMeta = {
      key,
      sha256: sha,
      mime: shot.mime,
      bytes: shot.bytes.length,
      width: shot.width,
      height: shot.height,
      profile: shot.profile,
      kind: shot.kind,
    };
    const list = this.staged.get(runId) ?? [];
    list.push(meta);
    this.staged.set(runId, list);
    return meta;
  }

  async commitAll(runId: string): Promise<void> {
    const metas = this.staged.get(runId) ?? [];
    for (const meta of metas) {
      const dest = this.blobPath(meta.sha256);
      if (existsSync(dest)) {
        await rm(this.tmpPath(runId, meta.key), { force: true }); // dedup: blob already exists
        continue;
      }
      await mkdir(join(this.baseDir, 'blobs', meta.sha256.slice(0, 2)), { recursive: true });
      await rename(this.tmpPath(runId, meta.key), dest); // atomic move within the volume
    }
    await this.discardTemp(runId);
  }

  async discardTemp(runId: string): Promise<void> {
    this.staged.delete(runId);
    await rm(this.tmpDir(runId), { recursive: true, force: true });
  }

  async read(sha256: string): Promise<Buffer | null> {
    const path = this.blobPath(sha256);
    return existsSync(path) ? readFile(path) : null;
  }

  async gc(referencedSha: Set<string>): Promise<number> {
    const blobsRoot = join(this.baseDir, 'blobs');
    if (!existsSync(blobsRoot)) return 0;
    let removed = 0;
    for (const prefix of await readdir(blobsRoot)) {
      const dir = join(blobsRoot, prefix);
      if (!(await stat(dir)).isDirectory()) continue;
      for (const file of await readdir(dir)) {
        const sha = file.replace(/\.png$/, '');
        if (!referencedSha.has(sha)) {
          await rm(join(dir, file), { force: true });
          removed += 1;
        }
      }
    }
    return removed;
  }
}
