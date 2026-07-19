/**
 * Phase 11 Netlify deployment boundary. Provider-agnostic; Netlify-specific HTTP never
 * crosses this line. We create DRAFT deploys only (never touching the published production
 * deploy) against ONE pre-provisioned site, uploading an explicit allowlisted file package
 * atomically (digest file API — no CLI, no git/CD, no webhooks). The auth token is held only
 * inside the HTTP adapter and is never returned, logged, or persisted.
 */

/** One allowlisted file in a deploy package. */
export interface DeployFile {
  /** Site-root-relative path, always starting with '/'. */
  path: string;
  /** Raw bytes. */
  content: Buffer;
  /** sha1 hex (Netlify digest key) of the content. */
  sha1: string;
}

export interface DeployPackage {
  files: DeployFile[];
  totalBytes: number;
  fileCount: number;
  /** Stable hash of the approved demo artifact (the demo's stored content hash). */
  artifactHash: string;
}

export interface DeployCreateRequest {
  siteId: string;
  pkg: DeployPackage;
  /** Deterministic per-artifact attempt id, persisted BEFORE the call for reconciliation. */
  attemptFingerprint: string;
}

export type DeployState = 'enqueued' | 'building' | 'uploading' | 'ready' | 'error';

export interface DeployRef {
  deployId: string;
  state: DeployState;
  /** Opaque draft (deploy-preview) URL, e.g. https://<hash>--<site>.netlify.app */
  draftUrl: string | null;
  permalinkUrl: string | null;
}

/** Typed provider outcome. Transient/rate-limited are retryable and must NOT fail the lead. */
export type ProviderOutcome = 'ok' | 'rate_limited' | 'transient' | 'auth_error' | 'invalid';

export interface ProviderResult {
  outcome: ProviderOutcome;
  ref?: DeployRef;
  reason?: string;
}

export interface NetlifyDeploymentProvider {
  readonly name: string;
  /** Create a DRAFT deploy from the package (idempotent per attemptFingerprint where supported). */
  createDraftDeploy(req: DeployCreateRequest): Promise<ProviderResult>;
  /** Poll a deploy's state. */
  getDeploy(siteId: string, deployId: string): Promise<ProviderResult>;
  /** Reconciliation: find a prior deploy for this attempt fingerprint (title/metadata), if any. */
  findDeployByFingerprint(siteId: string, attemptFingerprint: string): Promise<ProviderResult & { found: boolean }>;
}
