import { type AccessTokenProvider, type GoogleOAuthClient } from './oauth.js';
import { type GmailTokenStore } from './token-store.js';

/**
 * Supplies a fresh OAuth access token from the stored refresh token, caching it in memory
 * until shortly before expiry. The refresh token never leaves the token store; access tokens
 * are never logged or persisted.
 */
export class OAuthAccessTokenProvider implements AccessTokenProvider {
  private cache: { token: string; expiresAt: number } | null = null;

  constructor(private readonly oauth: GoogleOAuthClient, private readonly store: GmailTokenStore) {}

  async getAccessToken(): Promise<string> {
    if (this.cache && Date.now() < this.cache.expiresAt - 60_000) return this.cache.token;
    const cred = await this.store.load();
    if (!cred) throw new Error('No Gmail credentials found — run `pnpm cli gmail-auth` first.');
    const { accessToken, expiresInSec } = await this.oauth.refreshAccessToken(cred.refreshToken);
    this.cache = { token: accessToken, expiresAt: Date.now() + expiresInSec * 1000 };
    return accessToken;
  }
}
