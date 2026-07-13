import { type Screenshot } from '../../domain/capture/capture-types.js';

export const CAPTURE_STORAGE_VERSION = 'cap-store-1';

/** Metadata for a staged/committed artifact. Paths never contain sensitive values. */
export interface ArtifactMeta {
  key: string; // deterministic logical key, e.g. "<pageIdx>-<profile>-<kind>"
  sha256: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  profile: 'desktop' | 'mobile';
  kind: 'viewport' | 'fullpage';
}

/**
 * Screenshot/artifact storage. Blobs are content-addressed and shared across runs.
 * Flow: stage to a run-scoped temp path (outside the DB tx) → write metadata in the
 * tx → commit temp→blob on success, or discard temp on rollback. GC deletes only
 * unreferenced blobs. Swappable for object storage without touching the pipeline.
 */
export interface CaptureStorageProvider {
  stage(runId: string, shot: Screenshot, pageIndex: number): Promise<ArtifactMeta>;
  commitAll(runId: string): Promise<void>;
  discardTemp(runId: string): Promise<void>;
  read(sha256: string): Promise<Buffer | null>;
  gc(referencedSha: Set<string>): Promise<number>;
}
