import { request as httpsRequest } from 'node:https';
import { type Logger } from 'pino';
import { type AccessTokenProvider } from './oauth.js';
import {
  type AccountVerification,
  type CreateDraftRequest,
  type GmailDraftProvider,
  type GmailOutcome,
  type GmailResult,
} from './provider.js';

/** Fixed Gmail API origin — never configurable. */
const GMAIL_API_ORIGIN = 'https://gmail.googleapis.com';

interface HttpJson {
  status: number;
  json: Record<string, unknown> | null;
}

/**
 * Gmail HTTP adapter. Uses ONLY users.drafts.create (draft creation) and, best-effort,
 * users.getProfile for account verification. The OAuth access token is fetched per call from
 * the token provider and used only as a Bearer header — NEVER logged or persisted. NOT
 * exercised by the standard test suite.
 */
export class HttpGmailDraftProvider implements GmailDraftProvider {
  readonly name = 'http-gmail';

  constructor(private readonly deps: { tokens: AccessTokenProvider; logger: Logger; timeoutMs: number }) {}

  private mapStatus(status: number): GmailOutcome {
    if (status >= 200 && status < 300) return 'ok';
    if (status === 401 || status === 403) return 'auth_error';
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'transient';
    return 'invalid';
  }

  private async call(method: string, path: string, body: unknown | null): Promise<HttpJson> {
    const token = await this.deps.tokens.getAccessToken(); // short-lived; never logged
    const payload = body === null ? null : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const url = new URL(GMAIL_API_ORIGIN + path);
      const req = httpsRequest(url, { method, timeout: this.deps.timeoutMs, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': String(payload.length) } : {}) } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: Record<string, unknown> | null;
          try { json = text ? (JSON.parse(text) as Record<string, unknown>) : null; } catch { json = null; }
          resolve({ status: res.statusCode ?? 0, json });
        });
      });
      req.on('timeout', () => req.destroy(new Error('gmail request timeout')));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async createDraft(req: CreateDraftRequest): Promise<GmailResult> {
    try {
      const res = await this.call('POST', '/gmail/v1/users/me/drafts', { message: { raw: req.rawBase64Url } });
      const outcome = this.mapStatus(res.status);
      if (outcome !== 'ok' || !res.json) return { outcome, reason: `drafts.create status ${String(res.status)}` };
      const message = (res.json.message ?? {}) as Record<string, unknown>;
      const draftId = typeof res.json.id === 'string' ? res.json.id : '';
      if (!draftId) return { outcome: 'invalid', reason: 'drafts.create response missing draft id' };
      return { outcome: 'ok', ref: { draftId, messageId: (message.id as string) ?? null, threadId: (message.threadId as string) ?? null } };
    } catch (err) {
      return { outcome: 'transient', reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async verifyAccount(expectedEmail: string): Promise<AccountVerification> {
    try {
      // getProfile requires a broader scope than gmail.compose; under compose-only it 403s.
      const res = await this.call('GET', '/gmail/v1/users/me/profile', null);
      if (res.status === 403 || res.status === 401) return { ok: false, email: null, reason: 'profile_not_accessible_under_compose_scope' };
      if (this.mapStatus(res.status) !== 'ok' || !res.json) return { ok: false, email: null, reason: `getProfile status ${String(res.status)}` };
      const email = (res.json.emailAddress as string) ?? null;
      return { ok: email === expectedEmail, email };
    } catch (err) {
      return { ok: false, email: null, reason: err instanceof Error ? err.message : String(err) };
    }
  }
}
