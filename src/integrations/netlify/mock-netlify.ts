import {
  type DeployCreateRequest,
  type DeployRef,
  type NetlifyDeploymentProvider,
  type ProviderResult,
} from './provider.js';

export interface MockNetlifyScript {
  /** Outcome of createDraftDeploy. */
  create?: ProviderResult;
  /** Sequence of getDeploy outcomes (polled in order; last repeats). */
  poll?: ProviderResult[];
  /** Reconciliation lookup result. */
  find?: ProviderResult & { found: boolean };
  /** Base host for synthesized opaque URLs. */
  hostname?: string;
}

/**
 * Deterministic Netlify provider for tests + mock runs. Zero network. A script controls the
 * create/poll/find outcomes so the full state machine (pending, ready, error, rate-limited,
 * transient, duplicate reconciliation) can be exercised without touching Netlify.
 */
export class MockNetlifyDeploymentProvider implements NetlifyDeploymentProvider {
  readonly name = 'mock-netlify';
  readonly created: DeployCreateRequest[] = [];
  private pollIdx = 0;

  constructor(private readonly script: MockNetlifyScript = {}) {}

  private synthRef(req: DeployCreateRequest, state: DeployRef['state']): DeployRef {
    const host = this.script.hostname ?? 'deploy-preview.netlify.app';
    const opaque = req.attemptFingerprint.slice(0, 24);
    const url = state === 'ready' ? `https://${opaque}--${host}` : null;
    return { deployId: `mock-deploy-${opaque}`, state, draftUrl: url, permalinkUrl: url };
  }

  async createDraftDeploy(req: DeployCreateRequest): Promise<ProviderResult> {
    this.created.push(req);
    if (this.script.create) {
      // Fill in a synthesized ref for an 'ok' create when the script didn't provide one.
      if (this.script.create.outcome === 'ok' && !this.script.create.ref) {
        return { outcome: 'ok', ref: this.synthRef(req, 'enqueued') };
      }
      return this.script.create;
    }
    return { outcome: 'ok', ref: this.synthRef(req, 'enqueued') };
  }

  async getDeploy(siteId: string, deployId: string): Promise<ProviderResult> {
    void siteId;
    const seq = this.script.poll;
    if (!seq || seq.length === 0) {
      // Default: the deploy is ready. Synthesize an opaque URL from the deploy id so both
      // freshly-created and reconciled/reused deploy ids resolve to a ready ref.
      const host = this.script.hostname ?? 'deploy-preview.netlify.app';
      const opaque = deployId.replace(/[^a-z0-9]/gi, '').slice(0, 24) || 'deploy';
      const url = `https://${opaque}--${host}`;
      return { outcome: 'ok', ref: { deployId, state: 'ready', draftUrl: url, permalinkUrl: url } };
    }
    const r = seq[Math.min(this.pollIdx, seq.length - 1)] as ProviderResult;
    this.pollIdx += 1;
    return r;
  }

  async findDeployByFingerprint(siteId: string, attemptFingerprint: string): Promise<ProviderResult & { found: boolean }> {
    void siteId; void attemptFingerprint;
    return this.script.find ?? { outcome: 'ok', found: false };
  }
}
