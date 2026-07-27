import { request as httpsRequest } from 'node:https';

/** Existing least-privilege grant. It supports draft compose/send but not inbox reading; each
 * Phase 12/15 adapter enforces its own narrower fixed endpoint allowlist. The scope is unchanged. */
export const GMAIL_COMPOSE_SCOPE = 'https://www.googleapis.com/auth/gmail.compose';

/**
 * Phase 17A2 read-only grant. Strictly READ-ONLY: it permits reading messages/threads and NO
 * mutation (no send, draft, label, archive, trash, or modify). It is stored in its OWN
 * credential file, entirely separate from the gmail.compose sending credential, so the two
 * grants never mix. The reply reader refuses to operate unless the stored scope is exactly this.
 */
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

/** Fixed Google endpoints — never configurable. */
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  timeoutMs: number;
}

export interface TokenExchangeResult {
  accessToken: string;
  refreshToken: string | null;
  expiresInSec: number;
}

/**
 * Minimal Google OAuth 2.0 client for the installed-app (loopback) flow. Requests ONLY the
 * gmail.compose scope with offline access so a refresh token is issued once. The client secret
 * and tokens are used only for the token exchange/refresh and are never logged. NOT exercised
 * by the standard test suite.
 */
export class GoogleOAuthClient {
  constructor(private readonly cfg: OAuthConfig) {}

  /**
   * Build the consent URL. `state` is a CSRF nonce the caller verifies on callback. `scope`
   * defaults to the compose scope (Phase 12 sending path, unchanged); the Phase 17A2 read-auth
   * flow passes GMAIL_READONLY_SCOPE for a strictly read-only grant.
   */
  authUrl(state: string, scope: string = GMAIL_COMPOSE_SCOPE): string {
    const p = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      response_type: 'code',
      scope,
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return `${AUTH_ENDPOINT}?${p.toString()}`;
  }

  async exchangeCode(code: string): Promise<TokenExchangeResult> {
    const body = new URLSearchParams({
      code, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret,
      redirect_uri: this.cfg.redirectUri, grant_type: 'authorization_code',
    });
    const json = await this.post(body);
    return { accessToken: String(json.access_token ?? ''), refreshToken: (json.refresh_token as string) ?? null, expiresInSec: Number(json.expires_in ?? 0) };
  }

  async refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresInSec: number }> {
    const body = new URLSearchParams({
      refresh_token: refreshToken, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, grant_type: 'refresh_token',
    });
    const json = await this.post(body);
    return { accessToken: String(json.access_token ?? ''), expiresInSec: Number(json.expires_in ?? 0) };
  }

  private post(body: URLSearchParams): Promise<Record<string, unknown>> {
    const payload = body.toString();
    return new Promise((resolve, reject) => {
      const url = new URL(TOKEN_ENDPOINT);
      const req = httpsRequest(url, { method: 'POST', timeout: this.cfg.timeoutMs, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': String(Buffer.byteLength(payload)) } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: Record<string, unknown> = {};
          try { json = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { /* leave empty */ }
          if ((res.statusCode ?? 0) >= 400) { reject(new Error(`token endpoint ${String(res.statusCode)}: ${String(json.error ?? 'error')}`)); return; }
          resolve(json);
        });
      });
      req.on('timeout', () => req.destroy(new Error('token request timeout')));
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }
}

/** Provides a fresh access token from the stored refresh token, caching until near expiry. */
export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
}
