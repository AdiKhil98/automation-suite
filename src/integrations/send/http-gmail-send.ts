import { request as httpsRequest } from 'node:https';
import { type AccessTokenProvider } from '../gmail/oauth.js';
import { parseKnownGmailDraft } from './gmail-draft-parser.js';
import { type DraftInspectionResult, type SendProvider, type SendResult } from './provider.js';

const GMAIL_API_ORIGIN = 'https://gmail.googleapis.com';

export interface GmailHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Readonly<Record<string, string>>;
  body: string | null;
  timeoutMs: number;
}
export interface GmailHttpResponse { status: number; body: string }
export interface GmailHttpTransport { request(input: GmailHttpRequest): Promise<GmailHttpResponse> }

/** One-shot HTTPS transport. It deliberately has no retry behavior. */
export class NodeGmailHttpTransport implements GmailHttpTransport {
  request(input: GmailHttpRequest): Promise<GmailHttpResponse> {
    return new Promise((resolve, reject) => {
      const req = httpsRequest(new URL(input.url), { method: input.method, timeout: input.timeoutMs, headers: input.headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('timeout', () => req.destroy(new Error('gmail_request_timeout')));
      req.on('error', reject);
      if (input.body !== null) req.write(input.body);
      req.end();
    });
  }
}

/** Phase 15 adapter: profile, one explicitly-known draft read, and send of that same draft id only. */
export class HttpGmailSendProvider implements SendProvider {
  readonly name = 'http-gmail-send';
  readonly live = true;

  constructor(private readonly deps: { tokens: AccessTokenProvider; timeoutMs: number; transport?: GmailHttpTransport }) {}

  async verifyAccount(expectedEmail: string): Promise<{ ok: boolean; email: string | null; reason?: string }> {
    const res = await this.safeCall('GET', '/gmail/v1/users/me/profile', null);
    if ('failure' in res) return { ok: false, email: null, reason: res.reason };
    if (res.status === 401 || res.status === 403) return { ok: false, email: null, reason: 'authentication_or_authorization_failure' };
    if (res.status === 429) return { ok: false, email: null, reason: 'rate_limited' };
    if (res.status >= 500) return { ok: false, email: null, reason: 'outcome_unknown' };
    if (res.status < 200 || res.status >= 300) return { ok: false, email: null, reason: 'definitive_failure' };
    const json = parseJson(res.body);
    const email = json && typeof json.emailAddress === 'string' ? json.emailAddress : null;
    if (!email) return { ok: false, email: null, reason: 'malformed_profile_response' };
    return { ok: email.toLowerCase() === expectedEmail.trim().toLowerCase(), email };
  }

  async getKnownDraft(providerDraftId: string): Promise<DraftInspectionResult> {
    if (!validId(providerDraftId)) return { outcome: 'invalid', reason: 'invalid_known_draft_id' };
    const path = `/gmail/v1/users/me/drafts/${encodeURIComponent(providerDraftId)}?format=raw`;
    const res = await this.safeCall('GET', path, null);
    if ('failure' in res) return { outcome: res.failure === 'auth' ? 'auth_error' : 'unknown', reason: res.reason };
    if (res.status === 404) return { outcome: 'missing', reason: 'known_draft_missing' };
    if (res.status === 401 || res.status === 403) return { outcome: 'auth_error', reason: 'authentication_or_authorization_failure' };
    if (res.status === 429) return { outcome: 'rate_limited', reason: 'rate_limited' };
    if (res.status >= 500) return { outcome: 'unknown', reason: 'provider_5xx' };
    if (res.status < 200 || res.status >= 300) return { outcome: 'definitive_failure', reason: 'draft_read_rejected' };
    const json = parseJson(res.body);
    if (!json) return { outcome: 'invalid', reason: 'malformed_draft_response' };
    try {
      const parsed = parseKnownGmailDraft(json, providerDraftId);
      return { outcome: 'ok', ...parsed };
    } catch (err) {
      return { outcome: 'invalid', reason: err instanceof Error ? err.message : 'invalid_draft' };
    }
  }

  async sendExistingDraft(providerDraftId: string): Promise<SendResult> {
    if (!validId(providerDraftId)) return { outcome: 'definitive_failure', reason: 'invalid_known_draft_id' };
    const body = JSON.stringify({ id: providerDraftId });
    const res = await this.safeCall('POST', '/gmail/v1/users/me/drafts/send', body);
    if ('failure' in res) return { outcome: res.failure === 'auth' ? 'auth_error' : 'unknown', reason: res.reason };
    if (res.status === 401 || res.status === 403) return { outcome: 'auth_error', reason: 'authentication_or_authorization_failure' };
    if (res.status === 429) return { outcome: 'rate_limited', reason: 'rate_limited' };
    if (res.status === 0 || res.status === 408 || res.status >= 500) return { outcome: 'unknown', reason: 'provider_uncertain_response' };
    if (res.status < 200 || res.status >= 300) return { outcome: 'definitive_failure', reason: 'draft_send_rejected' };
    const json = parseJson(res.body);
    if (!json || typeof json.id !== 'string' || json.id.length === 0 || (json.threadId !== undefined && typeof json.threadId !== 'string')) {
      return { outcome: 'unknown', reason: 'malformed_success_response' };
    }
    return { outcome: 'ok', ref: { providerMessageId: json.id, providerThreadId: typeof json.threadId === 'string' ? json.threadId : null } };
  }

  private async safeCall(method: 'GET' | 'POST', path: string, body: string | null): Promise<GmailHttpResponse | { failure: 'auth' | 'unknown'; reason: string }> {
    let token: string;
    try { token = await this.deps.tokens.getAccessToken(); }
    catch { return { failure: 'auth', reason: 'access_token_unavailable' }; }
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    if (body !== null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(Buffer.byteLength(body)); }
    try {
      return await (this.deps.transport ?? new NodeGmailHttpTransport()).request({ method, url: GMAIL_API_ORIGIN + path, headers, body, timeoutMs: this.deps.timeoutMs });
    } catch (err) {
      return { failure: 'unknown', reason: err instanceof Error && err.message === 'gmail_request_timeout' ? 'request_timeout' : 'network_failure' };
    }
  }
}

function parseJson(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
function validId(value: string): boolean { return /^[A-Za-z0-9_-]{1,256}$/.test(value); }
