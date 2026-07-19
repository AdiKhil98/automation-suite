import { existsSync, readFileSync } from 'node:fs';

export interface OAuthClientCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Resolve the OAuth client id/secret for the loopback flow. Prefers the credentials JSON
 * downloaded from Google Cloud — a **Desktop app** client (top-level `installed` key) or a
 * Web app client (`web` key) — so the secret never has to live in .env. Falls back to
 * GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET. Returns null when neither is configured.
 * The file is git-ignored; nothing here is logged.
 */
export function loadGmailClientCredentials(opts: { clientFile: string; envClientId?: string; envClientSecret?: string }): OAuthClientCredentials | null {
  if (existsSync(opts.clientFile)) {
    try {
      const raw = JSON.parse(readFileSync(opts.clientFile, 'utf8')) as Record<string, unknown>;
      const node = (raw.installed ?? raw.web) as { client_id?: unknown; client_secret?: unknown } | undefined;
      if (node && typeof node.client_id === 'string' && typeof node.client_secret === 'string') {
        return { clientId: node.client_id, clientSecret: node.client_secret };
      }
    } catch {
      /* malformed file → fall through to env */
    }
  }
  if (opts.envClientId && opts.envClientSecret) return { clientId: opts.envClientId, clientSecret: opts.envClientSecret };
  return null;
}
