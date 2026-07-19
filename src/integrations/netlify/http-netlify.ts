import { request as httpsRequest } from 'node:https';
import { type Logger } from 'pino';
import {
  type DeployCreateRequest,
  type DeployRef,
  type DeployState,
  type NetlifyDeploymentProvider,
  type ProviderOutcome,
  type ProviderResult,
} from './provider.js';

/** Official Netlify API origin — FIXED, never configurable (prevents exfiltration to a rogue host). */
const NETLIFY_API_ORIGIN = 'https://api.netlify.com';

interface HttpResponse {
  status: number;
  json: unknown;
  retryAfter: string | null;
}

/**
 * Netlify HTTP adapter. Creates DRAFT deploys via the digest file API against ONE site.
 * The auth token is used only as a Bearer header and is NEVER logged or returned. Requests
 * go only to the fixed official origin. NOT exercised by the standard test suite.
 */
export class HttpNetlifyDeploymentProvider implements NetlifyDeploymentProvider {
  readonly name = 'http-netlify';

  constructor(private readonly deps: { token: string; logger: Logger; timeoutMs: number }) {}

  private mapStatus(status: number): ProviderOutcome {
    if (status >= 200 && status < 300) return 'ok';
    if (status === 401 || status === 403) return 'auth_error';
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'transient';
    return 'invalid';
  }

  private mapState(s: unknown): DeployState {
    const v = typeof s === 'string' ? s : '';
    if (v === 'ready') return 'ready';
    if (v === 'error') return 'error';
    if (v === 'uploading' || v === 'uploaded') return 'uploading';
    if (v === 'building' || v === 'processing') return 'building';
    return 'enqueued';
  }

  private toRef(body: Record<string, unknown>): DeployRef {
    const draftUrl = (body.deploy_ssl_url as string) ?? (body.deploy_url as string) ?? null;
    return {
      deployId: String(body.id ?? ''),
      state: this.mapState(body.state),
      draftUrl,
      permalinkUrl: (body.links && typeof body.links === 'object' ? (body.links as Record<string, string>).permalink : null) ?? draftUrl,
    };
  }

  private req(method: string, path: string, body: Buffer | null, contentType: string): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      const url = new URL(NETLIFY_API_ORIGIN + path);
      const r = httpsRequest(
        url,
        {
          method,
          timeout: this.deps.timeoutMs,
          headers: {
            Authorization: `Bearer ${this.deps.token}`, // never logged
            'Content-Type': contentType,
            ...(body ? { 'Content-Length': String(body.length) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json: unknown;
            try { json = text ? JSON.parse(text) : null; } catch { json = null; }
            resolve({ status: res.statusCode ?? 0, json, retryAfter: (res.headers['retry-after'] as string) ?? null });
          });
        },
      );
      r.on('timeout', () => { r.destroy(new Error('netlify request timeout')); });
      r.on('error', reject);
      if (body) r.write(body);
      r.end();
    });
  }

  async createDraftDeploy(req: DeployCreateRequest): Promise<ProviderResult> {
    try {
      const files: Record<string, string> = {};
      for (const f of req.pkg.files) files[f.path] = f.sha1;
      // Step 1: declare the deploy (draft) with the file digest + fingerprint title for reconciliation.
      const create = await this.req('POST', `/api/v1/sites/${encodeURIComponent(req.siteId)}/deploys`, Buffer.from(JSON.stringify({ files, draft: true, title: req.attemptFingerprint })), 'application/json');
      const outcome = this.mapStatus(create.status);
      if (outcome !== 'ok' || !create.json || typeof create.json !== 'object') return { outcome, reason: `create status ${String(create.status)}` };
      const body = create.json as Record<string, unknown>;
      const deployId = String(body.id ?? '');
      const required = Array.isArray(body.required) ? (body.required as string[]) : [];
      // Step 2: upload only the required (missing) files, by sha1.
      for (const sha1 of required) {
        const file = req.pkg.files.find((f) => f.sha1 === sha1);
        if (!file) continue;
        const up = await this.req('PUT', `/api/v1/deploys/${encodeURIComponent(deployId)}/files${file.path}`, file.content, 'application/octet-stream');
        if (this.mapStatus(up.status) !== 'ok') return { outcome: this.mapStatus(up.status), reason: `upload ${file.path} status ${String(up.status)}` };
      }
      return { outcome: 'ok', ref: this.toRef(body) };
    } catch (err) {
      return { outcome: 'transient', reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async getDeploy(siteId: string, deployId: string): Promise<ProviderResult> {
    try {
      const res = await this.req('GET', `/api/v1/sites/${encodeURIComponent(siteId)}/deploys/${encodeURIComponent(deployId)}`, null, 'application/json');
      const outcome = this.mapStatus(res.status);
      if (outcome !== 'ok' || !res.json || typeof res.json !== 'object') return { outcome, reason: `get status ${String(res.status)}` };
      return { outcome: 'ok', ref: this.toRef(res.json as Record<string, unknown>) };
    } catch (err) {
      return { outcome: 'transient', reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async findDeployByFingerprint(siteId: string, attemptFingerprint: string): Promise<ProviderResult & { found: boolean }> {
    try {
      const res = await this.req('GET', `/api/v1/sites/${encodeURIComponent(siteId)}/deploys`, null, 'application/json');
      if (this.mapStatus(res.status) !== 'ok' || !Array.isArray(res.json)) return { outcome: this.mapStatus(res.status), found: false };
      const match = (res.json as Record<string, unknown>[]).find((d) => d.title === attemptFingerprint);
      return match ? { outcome: 'ok', found: true, ref: this.toRef(match) } : { outcome: 'ok', found: false };
    } catch (err) {
      return { outcome: 'transient', found: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }
}
